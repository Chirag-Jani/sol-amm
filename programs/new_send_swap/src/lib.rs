use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("DfMRpbJVP4g3Yi4S4zSmoFaqh7bvywzCjxZpkDKeZnXu");

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

        // Get pool balances BEFORE transfers
        let pool_token_a_balance_before = ctx.accounts.pool_token_a.amount;
        let pool_token_b_balance_before = ctx.accounts.pool_token_b.amount;

        // Calculate LP tokens based on deposit amounts BEFORE transfers
        let lp_tokens_to_mint =
            if pool_token_a_balance_before == 0 && pool_token_b_balance_before == 0 {
                // Initial liquidity - mint minimum amount for first deposit
                1_000_000 // 1 LP token with 6 decimals
            } else {
                // Subsequent liquidity - proportional to existing pool shares
                let lp_supply = ctx.accounts.lp_mint.supply;
                let lp_decimals = ctx.accounts.lp_mint.decimals;

                // Get token decimals from the mint accounts
                let token_a_decimals = ctx.accounts.token_a_mint.decimals;
                let token_b_decimals = ctx.accounts.token_b_mint.decimals;

                // Normalize amounts to a common decimal base (using LP token decimals as reference)
                // Formula: normalized_amount = raw_amount * (10^lp_decimals) / (10^token_decimals)
                let normalize_amount = |raw_amount: u64, token_decimals: u8| -> Result<u64> {
                    if token_decimals == lp_decimals {
                        Ok(raw_amount)
                    } else if token_decimals > lp_decimals {
                        // Token has more decimals than LP, so divide
                        let divisor = 10u64.pow((token_decimals - lp_decimals) as u32);
                        Ok(raw_amount / divisor)
                    } else {
                        // Token has fewer decimals than LP, so multiply
                        let multiplier = 10u64.pow((lp_decimals - token_decimals) as u32);
                        if raw_amount > u64::MAX / multiplier {
                            return err!(AmmError::ArithmeticOverflow);
                        }
                        Ok(raw_amount * multiplier)
                    }
                };

                // Normalize the amounts
                let normalized_amount_a = normalize_amount(amount_a, token_a_decimals)?;
                let normalized_amount_b = normalize_amount(amount_b, token_b_decimals)?;
                let normalized_pool_a =
                    normalize_amount(pool_token_a_balance_before, token_a_decimals)?;
                let normalized_pool_b =
                    normalize_amount(pool_token_b_balance_before, token_b_decimals)?;

                // Calculate LP tokens for token A using normalized amounts
                let lp_tokens_a = if normalized_pool_a > 0 {
                    if normalized_amount_a > 0 && lp_supply > 0 {
                        // Check if multiplication would overflow
                        if normalized_amount_a > u64::MAX / lp_supply {
                            return err!(AmmError::ArithmeticOverflow);
                        }
                        (normalized_amount_a * lp_supply) / normalized_pool_a
                    } else {
                        0
                    }
                } else {
                    0
                };

                // Calculate LP tokens for token B using normalized amounts
                let lp_tokens_b = if normalized_pool_b > 0 {
                    if normalized_amount_b > 0 && lp_supply > 0 {
                        if normalized_amount_b > u64::MAX / lp_supply {
                            return err!(AmmError::ArithmeticOverflow);
                        }
                        (normalized_amount_b * lp_supply) / normalized_pool_b
                    } else {
                        0
                    }
                } else {
                    0
                };

                // Take the minimum to maintain pool balance
                std::cmp::min(lp_tokens_a, lp_tokens_b)
            };

        // Verify minimum LP tokens
        require!(
            lp_tokens_to_mint >= min_lp_tokens,
            AmmError::SlippageExceeded
        );

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

        // Validate input amount
        require!(amount_in > 0, AmmError::InvalidAmount);

        // Calculate fee using existing fee numerator/denominator
        let fee = amount_in
            .checked_mul(pool.fee_numerator)
            .ok_or(AmmError::ArithmeticOverflow)?
            .checked_div(pool.fee_denominator)
            .ok_or(AmmError::ArithmeticOverflow)?;

        let amount_in_after_fee = amount_in
            .checked_sub(fee)
            .ok_or(AmmError::ArithmeticOverflow)?;

        // Get current pool balances
        let pool_token_in_balance = ctx.accounts.pool_token_in.amount;
        let pool_token_out_balance = ctx.accounts.pool_token_out.amount;

        // Validate pool has sufficient liquidity
        require!(pool_token_in_balance > 0, AmmError::InvalidAmount);
        require!(pool_token_out_balance > 0, AmmError::InvalidAmount);

        // Calculate amount_out using constant product formula with improved overflow protection
        // Formula: amount_out = (pool_token_out_balance * amount_in_after_fee) / (pool_token_in_balance + amount_in_after_fee)

        // First, check if the denominator would overflow
        let denominator = pool_token_in_balance
            .checked_add(amount_in_after_fee)
            .ok_or(AmmError::ArithmeticOverflow)?;

        // Calculate amount_out using a safer approach
        let amount_out = if pool_token_out_balance > 0 && amount_in_after_fee > 0 {
            // Use a more robust calculation that avoids overflow
            // We'll use a different approach: calculate the ratio first, then multiply

            // Calculate the ratio: amount_in_after_fee / (pool_token_in_balance + amount_in_after_fee)
            // This ratio will be between 0 and 1, so it's safe to multiply with pool_token_out_balance

            // First, check if the multiplication would overflow
            if pool_token_out_balance > u64::MAX / amount_in_after_fee {
                // If direct multiplication would overflow, use a different approach
                // Calculate: pool_token_out_balance * (amount_in_after_fee / denominator)
                // But we need to handle the division carefully to maintain precision

                // Use a scaling approach: multiply by a large number, divide, then scale back
                let scale = 1_000_000_000u64; // 1 billion for precision

                // Scale up the calculation to maintain precision
                let scaled_amount_in = amount_in_after_fee.saturating_mul(scale);
                let scaled_ratio = scaled_amount_in / denominator;
                let scaled_amount_out = pool_token_out_balance.saturating_mul(scaled_ratio);

                // Scale back down
                scaled_amount_out / scale
            } else {
                // Safe to do direct calculation
                let numerator = pool_token_out_balance * amount_in_after_fee;
                numerator / denominator
            }
        } else {
            0
        };

        // Verify minimum amount out
        require!(amount_out >= min_amount_out, AmmError::SlippageExceeded);

        // Transfer fee directly from user to owner (before the main transfer)
        if fee > 0 {
            let cpi_accounts_fee = Transfer {
                from: ctx.accounts.user_token_in.to_account_info(),
                to: ctx.accounts.owner_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            };
            let cpi_ctx_fee = CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts_fee,
            );
            token::transfer(cpi_ctx_fee, fee)?;
        }

        // Transfer remaining tokens from user to pool (amount_in_after_fee)
        let cpi_accounts_in = Transfer {
            from: ctx.accounts.user_token_in.to_account_info(),
            to: ctx.accounts.pool_token_in.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx_in = CpiContext::new(cpi_program.clone(), cpi_accounts_in);
        token::transfer(cpi_ctx_in, amount_in_after_fee)?;

        // Transfer output tokens from pool to user
        let cpi_accounts_out = Transfer {
            from: ctx.accounts.pool_token_out.to_account_info(),
            to: ctx.accounts.user_token_out.to_account_info(),
            authority: ctx.accounts.pool.to_account_info(),
        };
        let seeds = [
            b"pool",
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

        // Validate input amount
        require!(lp_amount > 0, AmmError::InvalidAmount);

        // Get current pool balances and LP supply
        let pool_token_a_balance = ctx.accounts.pool_token_a.amount;
        let pool_token_b_balance = ctx.accounts.pool_token_b.amount;
        let lp_supply = ctx.accounts.lp_mint.supply;

        // Validate LP supply is not zero
        require!(lp_supply > 0, AmmError::InvalidAmount);

        // Calculate proportional amounts of tokens to return using safer math
        let amount_a = if lp_amount > 0 && pool_token_a_balance > 0 {
            // Calculate: (lp_amount * pool_token_a_balance) / lp_supply
            // Check for overflow before multiplication
            if lp_amount > u64::MAX / pool_token_a_balance {
                return err!(AmmError::ArithmeticOverflow);
            }
            (lp_amount * pool_token_a_balance) / lp_supply
        } else {
            0
        };

        let amount_b = if lp_amount > 0 && pool_token_b_balance > 0 {
            // Calculate: (lp_amount * pool_token_b_balance) / lp_supply
            // Check for overflow before multiplication
            if lp_amount > u64::MAX / pool_token_b_balance {
                return err!(AmmError::ArithmeticOverflow);
            }
            (lp_amount * pool_token_b_balance) / lp_supply
        } else {
            0
        };

        // Verify minimum amounts
        require!(amount_a >= min_amount_a, AmmError::SlippageExceeded);
        require!(amount_b >= min_amount_b, AmmError::SlippageExceeded);

        // Create signer seeds for pool authority
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

        // Burn LP tokens - user is the authority for their own tokens
        let cpi_accounts_burn = token::Burn {
            mint: ctx.accounts.lp_mint.to_account_info(),
            from: ctx.accounts.user_lp.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_ctx_burn = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts_burn,
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

    #[account(mut)]
    pub token_a_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub token_b_account: Account<'info, TokenAccount>,

    #[account(mut)]
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

    pub token_a_mint: Account<'info, Mint>,
    pub token_b_mint: Account<'info, Mint>,

    #[account(mut)]
    pub user_token_a: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_b: Account<'info, TokenAccount>,

    #[account(mut)]
    pub pool_token_a: Account<'info, TokenAccount>,

    #[account(mut)]
    pub pool_token_b: Account<'info, TokenAccount>,

    #[account(mut)]
    pub lp_mint: Account<'info, Mint>,

    #[account(mut)]
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

    #[account(mut)]
    pub token_in_mint: Account<'info, Mint>,

    #[account(mut)]
    pub token_out_mint: Account<'info, Mint>,

    #[account(mut)]
    pub user_token_in: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_out: Account<'info, TokenAccount>,

    #[account(mut)]
    pub pool_token_in: Account<'info, TokenAccount>,

    #[account(mut)]
    pub pool_token_out: Account<'info, TokenAccount>,

    #[account(mut)]
    pub owner_token_account: Account<'info, TokenAccount>,

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

    pub token_a_mint: Account<'info, Mint>,
    pub token_b_mint: Account<'info, Mint>,

    #[account(mut)]
    pub user_token_a: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_b: Account<'info, TokenAccount>,

    #[account(mut)]
    pub pool_token_a: Account<'info, TokenAccount>,

    #[account(mut)]
    pub pool_token_b: Account<'info, TokenAccount>,

    #[account(mut)]
    pub lp_mint: Account<'info, Mint>,

    #[account(mut)]
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
