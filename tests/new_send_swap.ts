import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  AuthorityType,
  createAccount,
  createAssociatedTokenAccount,
  createMint,
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

    // Create new token accounts for the swap user
    const userTokenAAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      tokenAMint,
      newAccount.publicKey
    );
    console.log("userTokenAAccount created:", userTokenAAccount.toString());
    await sleep(2000); // Increased delay to ensure transaction is confirmed

    const userTokenBAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      tokenBMint,
      newAccount.publicKey
    );
    console.log("userTokenBAccount created:", userTokenBAccount.toString());
    await sleep(2000); // Increased delay to ensure transaction is confirmed

    // Create owner token account to receive fees (using payer as owner for test)
    const ownerTokenAAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      tokenAMint,
      payer.publicKey // Using payer as owner since we need to match OWNER_PUBKEY
    );
    console.log("ownerTokenAAccount created:", ownerTokenAAccount.toString());
    await sleep(2000);

    // Airdrop SOL to the new account
    const airdropSignature = await provider.connection.requestAirdrop(
      newAccount.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSignature, "confirmed");
    console.log("Airdropped SOL to new account");
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
    await sleep(2000); // Increased delay to ensure transaction is confirmed

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
          ownerTokenAccount: ownerTokenAAccount, // Added owner token account
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

    // First verify which account has the LP tokens
    console.log("\n1. Checking LP token balance...");
    const userLpBalance = await provider.connection.getTokenAccountBalance(
      userLpAccount
    );
    console.log("User LP token account:", userLpAccount.toString());
    console.log("User LP token balance:", userLpBalance.value.amount);

    if (userLpBalance.value.amount === "0") {
      throw new Error("No LP tokens found in the account");
    }

    const lpAmount = new anchor.BN(userLpBalance.value.amount);
    console.log("LP tokens to burn:", lpAmount.toString());

    // Calculate minimum amounts (90% of expected)
    const minTokenA = new anchor.BN(900_000_000); // 90% of 1_000_000_000
    const minTokenB = new anchor.BN(900_000_000); // 90% of 1_000_000_000

    try {
      console.log("\n2. Preparing remove liquidity transaction...");
      console.log("Account states before removal:");
      console.log("Pool address:", poolAddress.toString());
      console.log("User (payer):", payer.publicKey.toString());
      console.log("LP Mint:", lpMint.toString());
      console.log("User LP Account:", userLpAccount.toString());
      console.log("User Token A Account:", userTokenAAccount.toString());
      console.log("User Token B Account:", userTokenBAccount.toString());
      console.log("Pool Token A Account:", poolTokenAAccount.toString());
      console.log("Pool Token B Account:", poolTokenBAccount.toString());

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
          userLp: userLpAccount, // Use user's LP account directly
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([payer])
        .rpc({ commitment: "confirmed" });

      console.log("\n3. Transaction sent:", tx);
      await provider.connection.confirmTransaction(tx, "confirmed");
      console.log("Transaction confirmed");
      await sleep(2000);

      console.log("\n4. Verifying final balances...");
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

      // Verify pool is empty
      assert.equal(finalPoolABalance.value.amount, "0");
      assert.equal(finalPoolBBalance.value.amount, "0");
      console.log("✓ Pool is empty");

      // Verify user received their tokens back
      assert.equal(finalUserABalance.value.amount, "1000000000");
      assert.equal(finalUserBBalance.value.amount, "1000000000");
      console.log("✓ User received tokens back");
    } catch (error) {
      console.error("\n❌ Error in remove liquidity test:");
      console.error("Error type:", error.constructor.name);
      console.error("Error message:", error.message);

      if (error.logs) {
        console.error("\nTransaction logs:");
        error.logs.forEach((log: string) => console.error(log));
      }

      // Log the current state of accounts
      console.log("\nAccount states at time of error:");
      try {
        const userLpInfo = await provider.connection.getAccountInfo(
          userLpAccount
        );
        const poolInfo = await provider.connection.getAccountInfo(poolAddress);
        console.log("User LP account exists:", !!userLpInfo);
        console.log("Pool account exists:", !!poolInfo);
      } catch (e) {
        console.error("Error getting account info:", e);
      }

      throw error;
    }
  });
});
