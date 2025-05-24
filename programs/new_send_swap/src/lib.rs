use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("9D7Q4mab5TnGjHTRxYB9hsShnZKq8S2DiKLU5WLcYNF6");

#[error_code]
pub enum AmmError {
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Invalid input amount")]
    InvalidAmount,
}

#[program]
pub mod new_send_swap {
    use super::*;

    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        fee_numerator: u64,
        fee_denominator: u64,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.token_a_mint = ctx.accounts.token_a_mint.key();
        pool.token_b_mint = ctx.accounts.token_b_mint.key();
        pool.token_a_account = ctx.accounts.token_a_account.key();
        pool.token_b_account = ctx.accounts.token_b_account.key();
        pool.lp_mint = ctx.accounts.lp_mint.key();
        pool.fee_numerator = fee_numerator;
        pool.fee_denominator = fee_denominator;
        pool.authority = ctx.accounts.authority.key();
        pool.bump = ctx.bumps.pool;

        emit!(PoolCreatedEvent {
            pool: pool.key(),
            token_a_mint: pool.token_a_mint,
            token_b_mint: pool.token_b_mint,
            fee: fee_numerator as f64 / fee_denominator as f64,
        });

        Ok(())
    }

    pub fn add_liquidity(
        ctx: Context<AddLiquidity>,
        amount_a: u64,
        amount_b: u64,
        min_lp_tokens: u64,
    ) -> Result<()> {
        let pool = &ctx.accounts.pool;

        // Transfer token A from user to pool
        let cpi_accounts_a = Transfer {
            from: ctx.accounts.user_token_a.to_account_info(),
            to: ctx.accounts.pool_token_a.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx_a = CpiContext::new(cpi_program.clone(), cpi_accounts_a);
        token::transfer(cpi_ctx_a, amount_a)?;

        // Transfer token B from user to pool
        let cpi_accounts_b = Transfer {
            from: ctx.accounts.user_token_b.to_account_info(),
            to: ctx.accounts.pool_token_b.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_ctx_b = CpiContext::new(cpi_program.clone(), cpi_accounts_b);
        token::transfer(cpi_ctx_b, amount_b)?;

        // Calculate LP tokens based on deposit amounts
        let lp_tokens_to_mint = if ctx.accounts.pool_token_a.amount == 0 {
            // Initial liquidity - mint minimum amount for first deposit
            1_000_000 // 1 LP token with 6 decimals
        } else {
            // Subsequent liquidity - proportional to existing pool shares
            let pool_token_a_balance = ctx.accounts.pool_token_a.amount;
            let pool_token_b_balance = ctx.accounts.pool_token_b.amount;

            // Calculate the proportion based on the smaller ratio to maintain pool balance
            std::cmp::min(
                amount_a
                    .checked_mul(ctx.accounts.lp_mint.supply)
                    .ok_or(AmmError::ArithmeticOverflow)?
                    .checked_div(pool_token_a_balance)
                    .ok_or(AmmError::ArithmeticOverflow)?,
                amount_b
                    .checked_mul(ctx.accounts.lp_mint.supply)
                    .ok_or(AmmError::ArithmeticOverflow)?
                    .checked_div(pool_token_b_balance)
                    .ok_or(AmmError::ArithmeticOverflow)?,
            )
        };

        // Verify minimum LP tokens
        require!(
            lp_tokens_to_mint >= min_lp_tokens,
            AmmError::SlippageExceeded
        );

        // Mint LP tokens to user
        let pool_seeds = [
            b"pool",
            ctx.accounts.pool.token_a_mint.as_ref(),
            ctx.accounts.pool.token_b_mint.as_ref(),
            &[ctx.accounts.pool.bump],
        ];
        let signer_seeds = [&pool_seeds[..]];

        let cpi_accounts_mint = token::MintTo {
            mint: ctx.accounts.lp_mint.to_account_info(),
            to: ctx.accounts.user_lp.to_account_info(),
            authority: ctx.accounts.pool.to_account_info(),
        };
        let cpi_ctx_mint = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts_mint,
            &signer_seeds,
        );
        token::mint_to(cpi_ctx_mint, lp_tokens_to_mint)?;

        emit!(LiquidityAddedEvent {
            pool: pool.key(),
            user: ctx.accounts.user.key(),
            amount_a,
            amount_b,
            lp_tokens_minted: lp_tokens_to_mint,
            pool_token_a_balance: ctx.accounts.pool_token_a.amount,
            pool_token_b_balance: ctx.accounts.pool_token_b.amount,
        });

        Ok(())
    }

    pub fn swap(ctx: Context<Swap>, amount_in: u64, min_amount_out: u64) -> Result<()> {
        let pool = &ctx.accounts.pool;

        // Calculate the amount out based on constant product formula (x * y = k)
        // In a real implementation, this would account for fees and slippage

        // Transfer tokens from user to pool
        let cpi_accounts_in = Transfer {
            from: ctx.accounts.user_token_in.to_account_info(),
            to: ctx.accounts.pool_token_in.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx_in = CpiContext::new(cpi_program.clone(), cpi_accounts_in);
        token::transfer(cpi_ctx_in, amount_in)?;

        // Calculate amount out after fees
        let fee = amount_in
            .checked_mul(pool.fee_numerator)
            .unwrap()
            .checked_div(pool.fee_denominator)
            .unwrap();

        let amount_in_after_fee = amount_in.checked_sub(fee).unwrap();

        // Get current pool balances
        let pool_token_in_balance = ctx.accounts.pool_token_in.amount;
        let pool_token_out_balance = ctx.accounts.pool_token_out.amount;

        // Calculate amount_out using constant product formula
        let amount_out = (pool_token_out_balance
            .checked_mul(amount_in_after_fee)
            .unwrap())
        .checked_div(
            pool_token_in_balance
                .checked_add(amount_in_after_fee)
                .unwrap(),
        )
        .unwrap();

        // Verify minimum amount out
        require!(amount_out >= min_amount_out, AmmError::SlippageExceeded);

        // Transfer tokens from pool to user
        let cpi_accounts_out = Transfer {
            from: ctx.accounts.pool_token_out.to_account_info(),
            to: ctx.accounts.user_token_out.to_account_info(),
            authority: ctx.accounts.pool.to_account_info(),
        };
        let seeds = [
            b"pool".as_ref(),
            ctx.accounts.pool.token_a_mint.as_ref(),
            ctx.accounts.pool.token_b_mint.as_ref(),
            &[ctx.accounts.pool.bump],
        ];
        let signer_seeds = [&seeds[..]];
        let cpi_ctx_out = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts_out,
            &signer_seeds,
        );
        token::transfer(cpi_ctx_out, amount_out)?;

        emit!(SwapExecutedEvent {
            pool: pool.key(),
            user: ctx.accounts.user.key(),
            token_in: ctx.accounts.token_in_mint.key(),
            token_out: ctx.accounts.token_out_mint.key(),
            amount_in,
            amount_out,
            fee,
        });

        Ok(())
    }

    pub fn remove_liquidity(
        ctx: Context<RemoveLiquidity>,
        lp_amount: u64,
        min_amount_a: u64,
        min_amount_b: u64,
    ) -> Result<()> {
        let pool = &ctx.accounts.pool;

        // Calculate proportional amounts of tokens to return
        let amount_a = (lp_amount
            .checked_mul(ctx.accounts.pool_token_a.amount)
            .unwrap())
        .checked_div(ctx.accounts.lp_mint.supply)
        .unwrap();

        let amount_b = (lp_amount
            .checked_mul(ctx.accounts.pool_token_b.amount)
            .unwrap())
        .checked_div(ctx.accounts.lp_mint.supply)
        .unwrap();

        // Verify minimum amounts
        require!(amount_a >= min_amount_a, AmmError::SlippageExceeded);
        require!(amount_b >= min_amount_b, AmmError::SlippageExceeded);

        // Create signer seeds for all CPIs
        let seeds = [
            b"pool".as_ref(),
            ctx.accounts.pool.token_a_mint.as_ref(),
            ctx.accounts.pool.token_b_mint.as_ref(),
            &[ctx.accounts.pool.bump],
        ];
        let signer_seeds = [&seeds[..]];

        // Transfer tokens from pool to user
        let cpi_accounts_a = Transfer {
            from: ctx.accounts.pool_token_a.to_account_info(),
            to: ctx.accounts.user_token_a.to_account_info(),
            authority: ctx.accounts.pool.to_account_info(),
        };
        let cpi_ctx_a = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts_a,
            &signer_seeds,
        );
        token::transfer(cpi_ctx_a, amount_a)?;

        let cpi_accounts_b = Transfer {
            from: ctx.accounts.pool_token_b.to_account_info(),
            to: ctx.accounts.user_token_b.to_account_info(),
            authority: ctx.accounts.pool.to_account_info(),
        };
        let cpi_ctx_b = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts_b,
            &signer_seeds,
        );
        token::transfer(cpi_ctx_b, amount_b)?;

        // Burn LP tokens
        let cpi_accounts_burn = token::Burn {
            mint: ctx.accounts.lp_mint.to_account_info(),
            from: ctx.accounts.user_lp.to_account_info(),
            authority: ctx.accounts.pool.to_account_info(),
        };
        let cpi_ctx_burn = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts_burn,
            &signer_seeds,
        );
        token::burn(cpi_ctx_burn, lp_amount)?;

        emit!(LiquidityRemovedEvent {
            pool: pool.key(),
            user: ctx.accounts.user.key(),
            amount_a,
            amount_b,
            lp_amount,
            pool_token_a_balance: ctx.accounts.pool_token_a.amount,
            pool_token_b_balance: ctx.accounts.pool_token_b.amount,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Pool::LEN,
        seeds = [
            b"pool",
            token_a_mint.key().as_ref(),
            token_b_mint.key().as_ref(),
        ],
        bump
    )]
    pub pool: Account<'info, Pool>,

    pub token_a_mint: Account<'info, Mint>,
    pub token_b_mint: Account<'info, Mint>,

    #[account(
        constraint = token_a_account.mint == token_a_mint.key(),
        constraint = token_a_account.owner == pool.key(),
    )]
    pub token_a_account: Account<'info, TokenAccount>,

    #[account(
        constraint = token_b_account.mint == token_b_mint.key(),
        constraint = token_b_account.owner == pool.key(),
    )]
    pub token_b_account: Account<'info, TokenAccount>,

    #[account(mut)]
    // #[account(
    //     mut,
    //     constraint = lp_mint.mint_authority.unwrap() == pool.key(),
    // )]
    pub lp_mint: Account<'info, Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(
        seeds = [
            b"pool",
            pool.token_a_mint.as_ref(),
            pool.token_b_mint.as_ref(),
        ],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = user_token_a.mint == pool.token_a_mint,
        constraint = user_token_a.owner == user.key(),
    )]
    pub user_token_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_b.mint == pool.token_b_mint,
        constraint = user_token_b.owner == user.key(),
    )]
    pub user_token_b: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = pool_token_a.mint == pool.token_a_mint,
        constraint = pool_token_a.key() == pool.token_a_account,
    )]
    pub pool_token_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = pool_token_b.mint == pool.token_b_mint,
        constraint = pool_token_b.key() == pool.token_b_account,
    )]
    pub pool_token_b: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = lp_mint.key() == pool.lp_mint,
    )]
    pub lp_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_lp.mint == pool.lp_mint,
        constraint = user_lp.owner == user.key(),
        constraint = user_lp.delegate.is_none(),
    )]
    pub user_lp: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(
        seeds = [
            b"pool",
            pool.token_a_mint.as_ref(),
            pool.token_b_mint.as_ref(),
        ],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        constraint = (
            token_in_mint.key() == pool.token_a_mint ||
            token_in_mint.key() == pool.token_b_mint
        ),
    )]
    pub token_in_mint: Account<'info, Mint>,

    #[account(
        constraint = (
            token_out_mint.key() == pool.token_a_mint ||
            token_out_mint.key() == pool.token_b_mint
        ),
        constraint = token_out_mint.key() != token_in_mint.key(),
    )]
    pub token_out_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_token_in.mint == token_in_mint.key(),
        constraint = user_token_in.owner == user.key(),
    )]
    pub user_token_in: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_out.mint == token_out_mint.key(),
        constraint = user_token_out.owner == user.key(),
    )]
    pub user_token_out: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = (
            (token_in_mint.key() == pool.token_a_mint && pool_token_in.key() == pool.token_a_account) ||
            (token_in_mint.key() == pool.token_b_mint && pool_token_in.key() == pool.token_b_account)
        ),
        constraint = pool_token_in.owner == pool.key(),
    )]
    pub pool_token_in: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = (
            (token_out_mint.key() == pool.token_a_mint && pool_token_out.key() == pool.token_a_account) ||
            (token_out_mint.key() == pool.token_b_mint && pool_token_out.key() == pool.token_b_account)
        ),
        constraint = pool_token_out.owner == pool.key(),
    )]
    pub pool_token_out: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
    #[account(
        seeds = [
            b"pool",
            pool.token_a_mint.as_ref(),
            pool.token_b_mint.as_ref(),
        ],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = user_token_a.mint == pool.token_a_mint,
        constraint = user_token_a.owner == user.key(),
    )]
    pub user_token_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_b.mint == pool.token_b_mint,
        constraint = user_token_b.owner == user.key(),
    )]
    pub user_token_b: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = pool_token_a.mint == pool.token_a_mint,
        constraint = pool_token_a.key() == pool.token_a_account,
    )]
    pub pool_token_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = pool_token_b.mint == pool.token_b_mint,
        constraint = pool_token_b.key() == pool.token_b_account,
    )]
    pub pool_token_b: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = lp_mint.key() == pool.lp_mint,
        constraint = lp_mint.mint_authority.unwrap() == pool.key(),
    )]
    pub lp_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_lp.mint == pool.lp_mint,
        constraint = user_lp.owner == user.key(),
        constraint = user_lp.delegate.is_none(),
    )]
    pub user_lp: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[account]
pub struct Pool {
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    pub token_a_account: Pubkey,
    pub token_b_account: Pubkey,
    pub lp_mint: Pubkey,
    pub fee_numerator: u64,
    pub fee_denominator: u64,
    pub authority: Pubkey,
    pub bump: u8,
}

impl Pool {
    pub const LEN: usize = 32 + 32 + 32 + 32 + 32 + 8 + 8 + 32 + 1;
}

#[event]
pub struct PoolCreatedEvent {
    pub pool: Pubkey,
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    pub fee: f64,
}

#[event]
pub struct LiquidityAddedEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64,
    pub lp_tokens_minted: u64,
    pub pool_token_a_balance: u64,
    pub pool_token_b_balance: u64,
}

#[event]
pub struct SwapExecutedEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub token_in: Pubkey,
    pub token_out: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub fee: u64,
}

#[event]
pub struct LiquidityRemovedEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64,
    pub lp_amount: u64,
    pub pool_token_a_balance: u64,
    pub pool_token_b_balance: u64,
}
