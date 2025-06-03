import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  AuthorityType,
  createAccount,
  createAssociatedTokenAccount,
  createMint,
  getMint,
  mintTo,
  setAuthority,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { assert } from "chai";
import { NewSendSwap } from "../target/types/new_send_swap";

describe("new_send_swap", () => {
  // Create a new keypair for the test
  const payer = Keypair.generate();

  // Setup provider with the payer
  const provider = new anchor.AnchorProvider(
    anchor.getProvider().connection,
    new anchor.Wallet(payer),
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);

  const program = anchor.workspace.newSendSwap as Program<NewSendSwap>;

  // Global variables
  let tokenAMint: PublicKey;
  let tokenBMint: PublicKey;
  let lpMint: PublicKey;
  let poolAddress: PublicKey;
  let poolTokenAAccount: PublicKey;
  let poolTokenBAccount: PublicKey;
  let userTokenAAccount: PublicKey;
  let userTokenBAccount: PublicKey;
  let userLpAccount: PublicKey;

  // Add this helper function at the top of the file
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it("Initializes the pool", async () => {
    // First, airdrop some SOL to the payer
    const signature = await provider.connection.requestAirdrop(
      payer.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(signature);

    // Create token mints - assign to global variables
    tokenAMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      9
    );
    console.log("tokenAMint", tokenAMint);

    tokenBMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      9
    );
    console.log("tokenBMint", tokenBMint);

    lpMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      9
    );
    console.log("lpMint", lpMint);

    // Derive the pool address
    [poolAddress] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), tokenAMint.toBuffer(), tokenBMint.toBuffer()],
      program.programId
    );
    console.log("poolAddress", poolAddress);

    // Create new keypairs for token accounts
    const poolTokenAKeypair = Keypair.generate();
    const poolTokenBKeypair = Keypair.generate();

    // Create the token accounts - assign to global variables
    poolTokenAAccount = await createAccount(
      provider.connection,
      payer,
      tokenAMint,
      poolAddress,
      poolTokenAKeypair
    );
    console.log("poolTokenAAccount", poolTokenAAccount);

    poolTokenBAccount = await createAccount(
      provider.connection,
      payer,
      tokenBMint,
      poolAddress,
      poolTokenBKeypair
    );
    console.log("poolTokenBAccount", poolTokenBAccount);

    // Initialize the pool
    await program.methods
      .initializePool(
        new anchor.BN(3), // fee numerator (0.3%)
        new anchor.BN(1000) // fee denominator
      )
      .accounts({
        pool: poolAddress,
        tokenAMint,
        tokenBMint,
        tokenAAccount: poolTokenAAccount,
        tokenBAccount: poolTokenBAccount,
        lpMint,
        authority: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([payer])
      .rpc();

    // After the pool is initialized, set the pool as mint authority
    await setAuthority(
      provider.connection,
      payer,
      lpMint,
      payer.publicKey,
      AuthorityType.MintTokens,
      poolAddress
    );

    // Verify the pool was initialized correctly
    const poolAccount = await program.account.pool.fetch(poolAddress);
    assert.ok(poolAccount.tokenAMint.equals(tokenAMint));
    assert.ok(poolAccount.tokenBMint.equals(tokenBMint));
    assert.ok(poolAccount.tokenAAccount.equals(poolTokenAAccount));
    assert.ok(poolAccount.tokenBAccount.equals(poolTokenBAccount));
    assert.ok(poolAccount.lpMint.equals(lpMint));
    assert.equal(poolAccount.feeNumerator.toNumber(), 3);
    assert.equal(poolAccount.feeDenominator.toNumber(), 1000);
    assert.ok(poolAccount.authority.equals(payer.publicKey));
  });

  it("Adds initial liquidity to the pool", async () => {
    // Create user token accounts
    userTokenAAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      tokenAMint,
      payer.publicKey
    );

    await sleep(1000); // Add delay between transactions

    userTokenBAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      tokenBMint,
      payer.publicKey
    );

    await sleep(1000); // Add delay between transactions

    userLpAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      lpMint,
      payer.publicKey
    );

    await sleep(1000); // Add delay between transactions

    // Mint initial tokens to the user
    const amountA = new anchor.BN(1_000_000_000);
    const amountB = new anchor.BN(1_000_000_000);

    await mintTo(
      provider.connection,
      payer,
      tokenAMint,
      userTokenAAccount,
      payer.publicKey,
      amountA.toNumber()
    );

    await sleep(1000); // Add delay between transactions

    await mintTo(
      provider.connection,
      payer,
      tokenBMint,
      userTokenBAccount,
      payer.publicKey,
      amountB.toNumber()
    );

    await sleep(1000); // Add delay between transactions

    try {
      const tx = await program.methods
        .addLiquidity(amountA, amountB, new anchor.BN(0))
        .accounts({
          pool: poolAddress,
          user: payer.publicKey,
          userTokenA: userTokenAAccount,
          userTokenB: userTokenBAccount,
          poolTokenA: poolTokenAAccount,
          poolTokenB: poolTokenBAccount,
          lpMint,
          userLp: userLpAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([payer])
        .rpc({ commitment: "confirmed" }); // Add explicit commitment level

      // Wait for longer confirmation
      await provider.connection.confirmTransaction(tx, "confirmed");
      await sleep(2000); // Add additional delay after confirmation

      // Verify balances
      const poolTokenABalance =
        await provider.connection.getTokenAccountBalance(poolTokenAAccount);
      const poolTokenBBalance =
        await provider.connection.getTokenAccountBalance(poolTokenBAccount);
      const userLpBalance = await provider.connection.getTokenAccountBalance(
        userLpAccount
      );

      assert.equal(poolTokenABalance.value.amount, "1000000000");
      assert.equal(poolTokenBBalance.value.amount, "1000000000");
      assert.equal(userLpBalance.value.amount, "1000000"); // Note: this is the expected initial LP token amount
    } catch (error) {
      console.error("Error adding liquidity:", error);
      throw error;
    }
  });

  it("Executes a swap", async () => {
    // First get the pool account to determine token order
    const poolAccount = await program.account.pool.fetch(poolAddress);
    const newAccount = Keypair.generate();

    // Airdrop SOL to the new account first
    const airdropSignature = await provider.connection.requestAirdrop(
      newAccount.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSignature, "confirmed");
    console.log("Airdropped SOL to new account");
    await sleep(2000);

    // Create new keypairs for token accounts
    const userTokenAKeypair = Keypair.generate();
    const userTokenBKeypair = Keypair.generate();
    const ownerTokenAKeypair = Keypair.generate();

    // Create token accounts using createAccount instead of createAssociatedTokenAccount
    const userTokenAAccount = await createAccount(
      provider.connection,
      newAccount, // payer
      tokenAMint,
      newAccount.publicKey, // owner
      userTokenAKeypair
    );
    console.log("userTokenAAccount created:", userTokenAAccount.toString());
    await sleep(2000);

    const userTokenBAccount = await createAccount(
      provider.connection,
      newAccount, // payer
      tokenBMint,
      newAccount.publicKey, // owner
      userTokenBKeypair
    );
    console.log("userTokenBAccount created:", userTokenBAccount.toString());
    await sleep(2000);

    // Create owner token account to receive fees using createAccount
    const ownerTokenAAccount = await createAccount(
      provider.connection,
      payer, // payer
      tokenAMint,
      payer.publicKey, // owner
      ownerTokenAKeypair
    );
    console.log("ownerTokenAAccount created:", ownerTokenAAccount.toString());
    await sleep(2000);

    // Fund the user's token A account for swapping
    const swapAmount = new anchor.BN(100_000_000); // 100 tokens with 9 decimals
    const mintTx = await mintTo(
      provider.connection,
      payer,
      tokenAMint,
      userTokenAAccount,
      payer.publicKey,
      swapAmount.toNumber()
    );
    await provider.connection.confirmTransaction(mintTx, "confirmed");
    console.log("Minted tokens to userTokenAAccount");
    await sleep(2000);

    try {
      // Get initial owner balance to verify fee transfer
      const initialOwnerBalance =
        await provider.connection.getTokenAccountBalance(ownerTokenAAccount);
      console.log("Initial owner balance:", initialOwnerBalance.value.amount);

      // Execute the swap
      const minAmountOut = new anchor.BN(90_000_000); // Expect at least 90 tokens out
      const tx = await program.methods
        .swap(swapAmount, minAmountOut)
        .accounts({
          pool: poolAddress,
          user: newAccount.publicKey,
          tokenInMint: poolAccount.tokenAMint,
          tokenOutMint: poolAccount.tokenBMint,
          userTokenIn: userTokenAAccount,
          userTokenOut: userTokenBAccount,
          poolTokenIn: poolAccount.tokenAAccount,
          poolTokenOut: poolAccount.tokenBAccount,
          ownerTokenAccount: ownerTokenAAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([newAccount])
        .rpc({ commitment: "confirmed" });

      await provider.connection.confirmTransaction(tx, "confirmed");
      await sleep(2000);

      // Verify the swap was successful
      const finalUserABalance =
        await provider.connection.getTokenAccountBalance(userTokenAAccount);
      const finalUserBBalance =
        await provider.connection.getTokenAccountBalance(userTokenBAccount);
      const finalPoolABalance =
        await provider.connection.getTokenAccountBalance(
          poolAccount.tokenAAccount
        );
      const finalPoolBBalance =
        await provider.connection.getTokenAccountBalance(
          poolAccount.tokenBAccount
        );
      const finalOwnerBalance =
        await provider.connection.getTokenAccountBalance(ownerTokenAAccount);

      console.log("\nFinal balances:");
      console.log("User Token A:", finalUserABalance.value.amount);
      console.log("User Token B:", finalUserBBalance.value.amount);
      console.log("Pool Token A:", finalPoolABalance.value.amount);
      console.log("Pool Token B:", finalPoolBBalance.value.amount);
      console.log("Owner Token A (fees):", finalOwnerBalance.value.amount);

      // Verify owner received fees
      const ownerReceivedFees =
        parseInt(finalOwnerBalance.value.amount) -
        parseInt(initialOwnerBalance.value.amount);
      console.log("Fees received by owner:", ownerReceivedFees);

      // With 0.3% fee (3/1000), expect fee = 100_000_000 * 3 / 1000 = 300_000
      const expectedFee = 300_000;
      assert.equal(
        ownerReceivedFees,
        expectedFee,
        "Owner should receive correct fee amount"
      );
    } catch (error) {
      console.error("Error executing swap:", error);

      // Add more detailed error logging
      if (error.logs) {
        console.error("Transaction logs:", error.logs);
      }

      // Check token account states
      const userAInfo = await provider.connection.getAccountInfo(
        userTokenAAccount
      );
      const userBInfo = await provider.connection.getAccountInfo(
        userTokenBAccount
      );
      console.log("User Token A account exists:", !!userAInfo);
      console.log("User Token B account exists:", !!userBInfo);

      throw error;
    }
  });
  it("Removes liquidity from the pool", async () => {
    console.log("\n=== Starting Remove Liquidity Test ===");

    // Get current pool balances before removal
    const poolTokenABalanceBefore =
      await provider.connection.getTokenAccountBalance(poolTokenAAccount);
    const poolTokenBBalanceBefore =
      await provider.connection.getTokenAccountBalance(poolTokenBAccount);

    console.log("\nPool balances before removal:");
    console.log("Pool Token A:", poolTokenABalanceBefore.value.amount);
    console.log("Pool Token B:", poolTokenBBalanceBefore.value.amount);

    // Get LP token balance
    const userLpBalance = await provider.connection.getTokenAccountBalance(
      userLpAccount
    );
    console.log("User LP token balance:", userLpBalance.value.amount);

    if (userLpBalance.value.amount === "0") {
      throw new Error("No LP tokens found in the account");
    }

    const lpAmount = new anchor.BN(userLpBalance.value.amount);
    console.log("LP tokens to burn:", lpAmount.toString());

    // Get LP mint supply using getMint
    const lpMintAccount = await getMint(provider.connection, lpMint);
    const supply = new anchor.BN(lpMintAccount.supply.toString());

    console.log("LP supply:", supply.toString());

    // Calculate expected amounts based on current pool balances
    const expectedTokenA = new anchor.BN(poolTokenABalanceBefore.value.amount)
      .mul(lpAmount)
      .div(supply);
    const expectedTokenB = new anchor.BN(poolTokenBBalanceBefore.value.amount)
      .mul(lpAmount)
      .div(supply);

    console.log("Expected Token A return:", expectedTokenA.toString());
    console.log("Expected Token B return:", expectedTokenB.toString());

    // Calculate minimum amounts (90% of expected)
    const minTokenA = expectedTokenA
      .mul(new anchor.BN(90))
      .div(new anchor.BN(100));
    const minTokenB = expectedTokenB
      .mul(new anchor.BN(90))
      .div(new anchor.BN(100));

    try {
      const tx = await program.methods
        .removeLiquidity(lpAmount, minTokenA, minTokenB)
        .accounts({
          pool: poolAddress,
          user: payer.publicKey,
          userTokenA: userTokenAAccount,
          userTokenB: userTokenBAccount,
          poolTokenA: poolTokenAAccount,
          poolTokenB: poolTokenBAccount,
          lpMint,
          userLp: userLpAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([payer])
        .rpc({ commitment: "confirmed" });

      await provider.connection.confirmTransaction(tx, "confirmed");
      await sleep(2000);

      // Verify balances after removal
      const finalUserABalance =
        await provider.connection.getTokenAccountBalance(userTokenAAccount);
      const finalUserBBalance =
        await provider.connection.getTokenAccountBalance(userTokenBAccount);
      const finalPoolABalance =
        await provider.connection.getTokenAccountBalance(poolTokenAAccount);
      const finalPoolBBalance =
        await provider.connection.getTokenAccountBalance(poolTokenBAccount);
      const finalLpBalance = await provider.connection.getTokenAccountBalance(
        userLpAccount
      );

      console.log("\nFinal balances after removal:");
      console.log("User Token A:", finalUserABalance.value.amount);
      console.log("User Token B:", finalUserBBalance.value.amount);
      console.log("Pool Token A:", finalPoolABalance.value.amount);
      console.log("Pool Token B:", finalPoolBBalance.value.amount);
      console.log("User LP Balance:", finalLpBalance.value.amount);

      // Verify LP tokens are burned
      assert.equal(finalLpBalance.value.amount, "0");
      console.log("✓ LP tokens burned successfully");

      // Verify pool is empty (since user had all LP tokens)
      assert.equal(finalPoolABalance.value.amount, "0");
      assert.equal(finalPoolBBalance.value.amount, "0");
      console.log("✓ Pool is empty");

      // Verify user received expected amounts (approximately)
      const actualTokenA = new anchor.BN(finalUserABalance.value.amount);
      const actualTokenB = new anchor.BN(finalUserBBalance.value.amount);

      // Check that received amounts are close to expected (within 1% tolerance)
      const tokenADiff = actualTokenA.sub(expectedTokenA).abs();
      const tokenBDiff = actualTokenB.sub(expectedTokenB).abs();
      const tokenATolerance = expectedTokenA.div(new anchor.BN(100)); // 1%
      const tokenBTolerance = expectedTokenB.div(new anchor.BN(100)); // 1%

      assert.ok(
        tokenADiff.lte(tokenATolerance),
        `Token A amount ${actualTokenA.toString()} not within tolerance of expected ${expectedTokenA.toString()}`
      );
      assert.ok(
        tokenBDiff.lte(tokenBTolerance),
        `Token B amount ${actualTokenB.toString()} not within tolerance of expected ${expectedTokenB.toString()}`
      );

      console.log("✓ User received expected token amounts");
    } catch (error) {
      console.error("\n❌ Error in remove liquidity test:", error);
      throw error;
    }
  });
});
