# Solana AMM (Automated Market Maker) Program

This program implements a decentralized exchange (DEX) on Solana using the Automated Market Maker (AMM) model. It allows users to create liquidity pools, add/remove liquidity, and perform token swaps.

## Program Overview

The program is built using the Anchor framework and implements a constant product AMM (x \* y = k) similar to Uniswap V2. It supports:

1. Pool Initialization
2. Adding Liquidity
3. Removing Liquidity
4. Token Swaps

## Key Features

### 1. Pool Initialization

- Creates a new liquidity pool for a pair of tokens
- Sets up fee parameters (numerator and denominator)
- Initializes LP (Liquidity Provider) token mint
- Creates necessary token accounts for the pool

### 2. Adding Liquidity

- Users can add liquidity by depositing both tokens
- LP tokens are minted proportionally to the deposited amounts
- First deposit receives a minimum amount of LP tokens
- Subsequent deposits are calculated based on existing pool shares

### 3. Token Swaps

- Implements constant product formula (x \* y = k)
- Includes fee calculation and slippage protection
- Supports swapping between both tokens in the pool
- Emits events for tracking swap details

### 4. Removing Liquidity

- Users can burn LP tokens to withdraw their share of the pool
- Returns proportional amounts of both tokens
- Includes slippage protection
- Emits events for tracking liquidity removal

## Technical Details

### Program Structure

#### Accounts

- `Pool`: Main account storing pool information
  - Token mint addresses
  - Token account addresses
  - LP mint address
  - Fee parameters
  - Authority
  - Bump seed

#### Instructions

1. `initialize_pool`: Creates a new liquidity pool
2. `add_liquidity`: Adds liquidity to the pool
3. `swap`: Executes token swaps
4. `remove_liquidity`: Removes liquidity from the pool

### Error Handling

The program includes custom error types:

- `SlippageExceeded`: When swap or liquidity operation exceeds slippage tolerance
- `ArithmeticOverflow`: When mathematical operations overflow
- `InvalidAmount`: When input amounts are invalid

### Events

The program emits events for tracking:

- Pool creation
- Liquidity addition
- Swap execution
- Liquidity removal

## Security Features

1. **Slippage Protection**

   - Users can specify minimum output amounts
   - Prevents front-running and price manipulation

2. **Fee Mechanism**

   - Configurable fee parameters
   - Fees are collected in the input token

3. **Account Validation**
   - Comprehensive account constraints
   - Proper authority checks
   - Token account ownership verification

## Usage

### Prerequisites

- Solana CLI tools
- Anchor framework
- Rust toolchain

### Building

```bash
anchor build
```

### Testing

```bash
anchor test
```

## Program ID
