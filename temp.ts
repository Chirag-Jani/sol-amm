import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  createAccount,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
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

  // Test accounts
  let tokenAMint: PublicKey;
  let tokenBMint: PublicKey;
  let lpMint: PublicKey;
  let poolTokenAAccount: PublicKey;
  let poolTokenBAccount: PublicKey;
  let userTokenAAccount: PublicKey;
  let userTokenBAccount: PublicKey;
  let userLpAccount: PublicKey;
  let pool: PublicKey;
  let poolBump: number;

  // Convert to BN since Anchor expects BN for u64
  const FEE_NUMERATOR = new BN(30); // 0.3% fee
  const FEE_DENOMINATOR = new BN(10000);

  // Define pool account type
  type PoolAccount = {
    tokenAMint: PublicKey;
    tokenBMint: PublicKey;
    tokenAAccount: PublicKey;
    tokenBAccount: PublicKey;
    lpMint: PublicKey;
    feeNumerator: BN;
    feeDenominator: BN;
    authority: PublicKey;
    bump: number;
  };

  before(async () => {
    // Airdrop SOL to the payer
    const signature = await provider.connection.requestAirdrop(
      payer.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(signature);

    // Create token mints
    tokenAMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      9
    );

    tokenBMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      9
    );

    lpMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      9
    );

    // Find PDA for pool
    [pool, poolBump] = await PublicKey.findProgramAddress(
      [Buffer.from("pool"), tokenAMint.toBuffer(), tokenBMint.toBuffer()],
      program.programId
    );

    // Create regular token accounts for pool
    poolTokenAAccount = await createAccount(
      provider.connection,
      payer,
      tokenAMint,
      pool,
      program.programId
    );

    poolTokenBAccount = await createAccount(
      provider.connection,
      payer,
      tokenBMint,
      pool,
      program.programId
    );

    // Create user token accounts using ATAs
    userTokenAAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      tokenAMint,
      payer.publicKey
    );

    userTokenBAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      tokenBMint,
      payer.publicKey
    );

    userLpAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      lpMint,
      payer.publicKey
    );

    // Mint initial tokens to user
    await mintTo(
      provider.connection,
      payer,
      tokenAMint,
      userTokenAAccount,
      payer.publicKey,
      1_000_000_000 // 1000 tokens
    );

    await mintTo(
      provider.connection,
      payer,
      tokenBMint,
      userTokenBAccount,
      payer.publicKey,
      1_000_000_000 // 1000 tokens
    );
  });

  it("Initializes the pool", async () => {
    await program.methods
      .initializePool(FEE_NUMERATOR, FEE_DENOMINATOR)
      .accounts({
        pool,
        tokenAMint,
        tokenBMint,
        tokenAAccount: poolTokenAAccount,
        tokenBAccount: poolTokenBAccount,
        lpMint,
        authority: provider.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const poolAccount = (await program.account.pool.fetch(pool)) as PoolAccount;
    expect(poolAccount.tokenAMint.toBase58()).to.equal(tokenAMint.toBase58());
    expect(poolAccount.tokenBMint.toBase58()).to.equal(tokenBMint.toBase58());
    expect(poolAccount.tokenAAccount.toBase58()).to.equal(
      poolTokenAAccount.toBase58()
    );
    expect(poolAccount.tokenBAccount.toBase58()).to.equal(
      poolTokenBAccount.toBase58()
    );
    expect(poolAccount.lpMint.toBase58()).to.equal(lpMint.toBase58());
    expect(poolAccount.feeNumerator.toString()).to.equal(
      FEE_NUMERATOR.toString()
    );
    expect(poolAccount.feeDenominator.toString()).to.equal(
      FEE_DENOMINATOR.toString()
    );
    expect(poolAccount.authority.toBase58()).to.equal(
      provider.wallet.publicKey.toBase58()
    );
    expect(poolAccount.bump).to.equal(poolBump);
  });

  it("Adds liquidity to the pool", async () => {
    const amountA = new BN(100_000_000); // 100 tokens
    const amountB = new BN(200_000_000); // 200 tokens
    const minLpTokens = new BN(100_000_000); // 100 tokens

    const userTokenAAccountBefore = await getAccount(
      provider.connection,
      userTokenAAccount
    );
    const userTokenBAccountBefore = await getAccount(
      provider.connection,
      userTokenBAccount
    );

    await program.methods
      .addLiquidity(amountA, amountB, minLpTokens)
      .accounts({
        pool,
        user: provider.wallet.publicKey,
        userTokenA: userTokenAAccount,
        userTokenB: userTokenBAccount,
        poolTokenA: poolTokenAAccount,
        poolTokenB: poolTokenBAccount,
        lpMint,
        userLp: userLpAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const userTokenAAccountAfter = await getAccount(
      provider.connection,
      userTokenAAccount
    );
    const userTokenBAccountAfter = await getAccount(
      provider.connection,
      userTokenBAccount
    );
    const poolTokenAAccountAfter = await getAccount(
      provider.connection,
      poolTokenAAccount
    );
    const poolTokenBAccountAfter = await getAccount(
      provider.connection,
      poolTokenBAccount
    );

    expect(
      Number(userTokenAAccountBefore.amount - userTokenAAccountAfter.amount)
    ).to.equal(amountA.toNumber());
    expect(
      Number(userTokenBAccountBefore.amount - userTokenBAccountAfter.amount)
    ).to.equal(amountB.toNumber());
    expect(Number(poolTokenAAccountAfter.amount)).to.equal(amountA.toNumber());
    expect(Number(poolTokenBAccountAfter.amount)).to.equal(amountB.toNumber());
  });

  it("Executes a swap", async () => {
    const amountIn = new BN(10_000_000); // 10 tokens
    const minAmountOut = new BN(19_000_000); // 19 tokens (expecting roughly 2:1 ratio minus fees)

    const userTokenAAccountBefore = await getAccount(
      provider.connection,
      userTokenAAccount
    );
    const userTokenBAccountBefore = await getAccount(
      provider.connection,
      userTokenBAccount
    );

    await program.methods
      .swap(amountIn, minAmountOut)
      .accounts({
        pool,
        user: provider.wallet.publicKey,
        tokenInMint: tokenAMint,
        tokenOutMint: tokenBMint,
        userTokenIn: userTokenAAccount,
        userTokenOut: userTokenBAccount,
        poolTokenIn: poolTokenAAccount,
        poolTokenOut: poolTokenBAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const userTokenAAccountAfter = await getAccount(
      provider.connection,
      userTokenAAccount
    );
    const userTokenBAccountAfter = await getAccount(
      provider.connection,
      userTokenBAccount
    );

    expect(
      Number(userTokenAAccountBefore.amount - userTokenAAccountAfter.amount)
    ).to.equal(amountIn.toNumber());
    // Note: In a real implementation, we would check the exact amount received based on the constant product formula
    expect(
      Number(userTokenBAccountAfter.amount - userTokenBAccountBefore.amount)
    ).to.be.at.least(minAmountOut.toNumber());
  });
});
