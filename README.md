# Solana AMM (Automated Market Maker) Program

This program implements a decentralized exchange (DEX) on Solana using the Automated Market Maker (AMM) model. It allows users to create liquidity pools, add/remove liquidity, and perform token swaps.

## Program Overview

The program is built using the Anchor framework and implements a constant product AMM (x \* y = k) similar to Uniswap V2. It supports:

1. Pool Initialization
2. Adding Liquidity
3. Removing Liquidity
4. Token Swaps with Fee Collection

## Key Features

### 1. Pool Initialization

- Creates a new liquidity pool for a pair of tokens
- Sets up fee parameters (numerator and denominator)
- Initializes LP (Liquidity Provider) token mint
- Creates necessary token accounts for the pool
- Uses PDA (Program Derived Address) for pool authority

### 2. Adding Liquidity

- Users can add liquidity by depositing both tokens
- LP tokens are minted proportionally to the deposited amounts
- First deposit receives a fixed amount of LP tokens (1,000,000 with 9 decimals)
- Subsequent deposits are calculated based on existing pool shares
- Includes slippage protection with minimum LP token requirements

### 3. Token Swaps

- Implements constant product formula (x \* y = k)
- Includes configurable fee calculation (default 0.3%)
- Supports swapping between both tokens in the pool
- Fees are collected in the input token and transferred to owner account
- Includes slippage protection with minimum output amounts
- Emits events for tracking swap details

### 4. Removing Liquidity

- Users can burn LP tokens to withdraw their share of the pool
- Returns proportional amounts of both tokens based on current pool balances
- User burns their own LP tokens (user authority required)
- Includes slippage protection with minimum output amounts
- Pool can be completely drained when all LP tokens are burned
- Emits events for tracking liquidity removal

## Technical Details

### Program Structure

#### Accounts

- `Pool`: Main account storing pool information
  - Token A mint address
  - Token B mint address
  - Token A account address
  - Token B account address
  - LP mint address
  - Fee numerator and denominator
  - Authority
  - Bump seed for PDA

#### Instructions

1. `initialize_pool`: Creates a new liquidity pool

   - Sets fee parameters
   - Initializes pool with token accounts
   - Transfers LP mint authority to pool

2. `add_liquidity`: Adds liquidity to the pool

   - Transfers tokens from user to pool
   - Mints LP tokens to user
   - Calculates proportional shares

3. `swap`: Executes token swaps

   - Transfers input tokens from user to pool
   - Calculates output using constant product formula
   - Deducts fees and transfers to owner
   - Transfers output tokens to user

4. `remove_liquidity`: Removes liquidity from the pool
   - Burns user's LP tokens
   - Transfers proportional pool tokens to user
   - Calculates amounts based on current pool state

### Error Handling

The program includes custom error types:

- `SlippageExceeded`: When swap or liquidity operation exceeds slippage tolerance
- `ArithmeticOverflow`: When mathematical operations overflow
- `InvalidAmount`: When input amounts are invalid

### Events

The program emits comprehensive events for tracking:

- `PoolCreatedEvent`: Pool creation with fee details
- `LiquidityAddedEvent`: Liquidity addition with amounts and balances
- `SwapExecutedEvent`: Swap execution with amounts and fees
- `LiquidityRemovedEvent`: Liquidity removal with amounts and balances

## Security Features

1. **Slippage Protection**

   - Users can specify minimum output amounts for swaps
   - Users can specify minimum LP tokens when adding liquidity
   - Users can specify minimum token amounts when removing liquidity
   - Prevents front-running and price manipulation

2. **Fee Mechanism**

   - Configurable fee parameters (numerator/denominator)
   - Fees are collected in the input token during swaps
   - Fees are transferred to designated owner account

3. **Account Validation**

   - Comprehensive account constraints using Anchor
   - Proper authority checks for all operations
   - Token account ownership verification
   - PDA validation for pool authority

4. **Authority Management**
   - Pool uses PDA for authority (no private key)
   - Users maintain control of their own tokens
   - LP mint authority transferred to pool during initialization

## Test Suite

The program includes comprehensive tests covering:

1. **Pool Initialization Test**

   - Creates token mints and accounts
   - Initializes pool with fee parameters
   - Verifies pool state and authority setup

2. **Add Liquidity Test**

   - Tests initial liquidity provision
   - Verifies LP token minting
   - Checks pool balances after addition

3. **Swap Execution Test**

   - Tests token swapping functionality
   - Verifies fee collection
   - Checks constant product formula implementation
   - Uses separate accounts to avoid interference

4. **Remove Liquidity Test**
   - Tests LP token burning
   - Verifies proportional token return
   - Handles changed pool composition after swaps
   - Includes tolerance-based assertions

## Known Implementation Details

### Fee Collection

- Fees are calculated as: `fee = amount_in * fee_numerator / fee_denominator`
- Default fee is 0.3% (3/1000)
- Fees are transferred to owner account in input token

### LP Token Calculation

- Initial liquidity: Fixed 1,000,000 LP tokens (with 6 effective decimals)
- Subsequent additions: `min(amount_a * supply / balance_a, amount_b * supply / balance_b)`

### Constant Product Formula

- Output calculation: `amount_out = (balance_out * amount_in_after_fee) / (balance_in + amount_in_after_fee)`
- Maintains x \* y = k invariant after each swap

## Usage

### Prerequisites

- Solana CLI tools
- Anchor framework v0.29.0+
- Rust toolchain
- Node.js for tests

### Building

```bash
anchor build
```

### Testing

```bash
anchor test
```

### Deployment

```bash
# Deploy to localnet
anchor deploy

# Deploy to devnet
anchor deploy --provider.cluster devnet
```

## Program ID

The program ID is generated during build and can be found in:

- `target/types/new_send_swap.ts`
- `programs/new_send_swap/src/lib.rs` (declare_id! macro)

## Contributing

When contributing to this project:

1. Ensure all tests pass
2. Add tests for new functionality
3. Follow Rust and Anchor best practices
4. Update documentation for any changes

## License

This project is open source and available under the MIT License.
