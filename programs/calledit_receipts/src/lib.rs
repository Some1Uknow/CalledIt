// Anchor 0.32 expands compatibility cfgs that Rust's host-side check-cfg does
// not know about yet. These allowances apply to macro expansion only; the
// program's own checks remain linted normally.
#![allow(deprecated, unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{get_return_data, invoke},
    pubkey,
};

declare_id!("2Yr85XfdHiYHyjxWFkVJzPiL9xfKYx3w3vGw4eqcwMMM");

/// TxLINE's documented devnet program. A production deployment must use the
/// corresponding mainnet program in a separately reviewed build.
pub const TXLINE_DEVNET_PROGRAM_ID: Pubkey =
    pubkey!("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");

/// The only wallet allowed to initialize the singleton config PDA. Without
/// this guard, the first arbitrary caller after deployment could configure the
/// market program for themselves. This is the current devnet deployer; replace
/// it with a governed deployer before producing a separately reviewed mainnet
/// build.
pub const BOOTSTRAP_AUTHORITY: Pubkey = pubkey!("4A7feq8LPurnS7yThFCi8dBywYnJaZB2uCZE2gjJc7sD");

pub const MAX_SCORE: u8 = 15;
pub const SCORE_BUCKET_SIDE: usize = MAX_SCORE as usize + 1;
pub const SCORE_BUCKETS: usize = SCORE_BUCKET_SIDE * SCORE_BUCKET_SIDE;

#[program]
pub mod calledit_receipts {
    use super::*;

    /// Creates the immutable configuration for this devnet deployment.
    /// `authority` may create pools; `emergency_authority` may only pause new
    /// entries or move a pool to refund-only mode.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        authority: Pubkey,
        settlement_authority: Pubkey,
        emergency_authority: Pubkey,
        stake_lamports: u64,
        max_entries: u16,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.payer.key(),
            BOOTSTRAP_AUTHORITY,
            CalledItError::UnauthorizedBootstrapAuthority
        );
        require!(stake_lamports > 0, CalledItError::InvalidStake);
        require!(max_entries > 0, CalledItError::InvalidMaxEntries);

        let config = &mut ctx.accounts.config;
        config.authority = authority;
        config.settlement_authority = settlement_authority;
        config.emergency_authority = emergency_authority;
        config.stake_lamports = stake_lamports;
        config.max_entries = max_entries;
        config.paused = false;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn update_authorities(
        ctx: Context<UpdateConfig>,
        authority: Pubkey,
        settlement_authority: Pubkey,
        emergency_authority: Pubkey,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.current_authority.key(),
            ctx.accounts.config.authority,
            CalledItError::UnauthorizedAuthority
        );
        ctx.accounts.config.authority = authority;
        ctx.accounts.config.settlement_authority = settlement_authority;
        ctx.accounts.config.emergency_authority = emergency_authority;
        Ok(())
    }

    pub fn set_paused(ctx: Context<EmergencyConfig>, paused: bool) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.emergency_authority.key(),
            ctx.accounts.config.emergency_authority,
            CalledItError::UnauthorizedEmergencyAuthority
        );
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    /// A pool is created by the service signer, but all financial terms are
    /// derived from the immutable config. The signer cannot choose a fee or
    /// redirect a player payout.
    pub fn create_pool(
        ctx: Context<CreatePool>,
        pool_seed: [u8; 32],
        txline_fixture_id: i64,
        participant1_is_home: bool,
        lock_at: i64,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, CalledItError::ProgramPaused);
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.config.authority,
            CalledItError::UnauthorizedAuthority
        );
        require!(txline_fixture_id > 0, CalledItError::InvalidFixture);
        require!(
            lock_at > Clock::get()?.unix_timestamp,
            CalledItError::InvalidLockTime
        );

        let pool = &mut ctx.accounts.pool;
        pool.config = ctx.accounts.config.key();
        pool.vault = ctx.accounts.vault.key();
        pool.seed = pool_seed;
        pool.txline_fixture_id = txline_fixture_id;
        pool.participant1_is_home = participant1_is_home;
        pool.lock_at = lock_at;
        pool.stake_lamports = ctx.accounts.config.stake_lamports;
        pool.max_entries = ctx.accounts.config.max_entries;
        pool.entry_count = 0;
        pool.total_stake_lamports = 0;
        // A bounded Vec serializes to the same fixed allocation but prevents
        // Anchor from placing a 2 KB fixed array in every account-validation
        // stack frame (BPF has a 4 KB stack limit).
        pool.score_stakes = vec![0; SCORE_BUCKETS];
        pool.final_home_goals = 0;
        pool.final_away_goals = 0;
        pool.winning_stake_lamports = 0;
        pool.claimed_lamports = 0;
        pool.status = PoolStatus::Open;
        pool.vault_rent_lamports = Rent::get()?.minimum_balance(Vault::SPACE);
        pool.bump = ctx.bumps.pool;
        pool.vault_bump = ctx.bumps.vault;

        let vault = &mut ctx.accounts.vault;
        vault.pool = pool.key();
        vault.bump = ctx.bumps.vault;

        emit!(PoolCreated {
            pool: pool.key(),
            txline_fixture_id,
            lock_at,
            stake_lamports: pool.stake_lamports,
        });
        Ok(())
    }

    /// Players can enter once, with their wallet as the PDA seed. SOL is sent
    /// directly to a program-owned vault; no backend signer is involved.
    pub fn enter_pool(ctx: Context<EnterPool>, home_goals: u8, away_goals: u8) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        require!(!ctx.accounts.config.paused, CalledItError::ProgramPaused);
        require!(pool.status == PoolStatus::Open, CalledItError::PoolNotOpen);
        require!(
            Clock::get()?.unix_timestamp < pool.lock_at,
            CalledItError::PredictionsLocked
        );
        require!(
            home_goals <= MAX_SCORE && away_goals <= MAX_SCORE,
            CalledItError::InvalidScore
        );
        require!(pool.entry_count < pool.max_entries, CalledItError::PoolFull);

        let transfer = anchor_lang::system_program::Transfer {
            from: ctx.accounts.player.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
        };
        anchor_lang::system_program::transfer(
            CpiContext::new(ctx.accounts.system_program.to_account_info(), transfer),
            pool.stake_lamports,
        )?;

        let entry = &mut ctx.accounts.entry;
        entry.pool = pool.key();
        entry.player = ctx.accounts.player.key();
        entry.home_goals = home_goals;
        entry.away_goals = away_goals;
        entry.stake_lamports = pool.stake_lamports;
        entry.claimed = false;
        entry.bump = ctx.bumps.entry;

        let index = score_index(home_goals, away_goals)?;
        pool.score_stakes[index] = pool.score_stakes[index]
            .checked_add(pool.stake_lamports)
            .ok_or(CalledItError::ArithmeticOverflow)?;
        pool.total_stake_lamports = pool
            .total_stake_lamports
            .checked_add(pool.stake_lamports)
            .ok_or(CalledItError::ArithmeticOverflow)?;
        pool.entry_count = pool
            .entry_count
            .checked_add(1)
            .ok_or(CalledItError::ArithmeticOverflow)?;

        emit!(EntryPlaced {
            pool: pool.key(),
            player: entry.player,
            home_goals,
            away_goals,
            stake_lamports: entry.stake_lamports,
        });
        Ok(())
    }

    /// Validates the exact two full-game score values using TxLINE's published
    /// `validateStatV2` instruction. The final score is read from proven leaves,
    /// never supplied as a trusted backend value.
    pub fn settle_with_txline_proof(
        ctx: Context<SettleWithTxlineProof>,
        payload: TxlineStatValidationInput,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        require!(pool.status == PoolStatus::Open, CalledItError::PoolNotOpen);
        require!(
            Clock::get()?.unix_timestamp >= pool.lock_at,
            CalledItError::PredictionsStillOpen
        );
        // TxLINE's current stat proof proves score values, not the feed action
        // / final status. A separate finality signer may submit only after the
        // backend observes `game_finalised` with statusId/period 100. The score
        // itself remains cryptographically verified by TxLINE below.
        require_keys_eq!(
            ctx.accounts.settlement_authority.key(),
            ctx.accounts.config.settlement_authority,
            CalledItError::UnauthorizedSettlementAuthority
        );
        require_keys_eq!(
            ctx.accounts.txline_program.key(),
            TXLINE_DEVNET_PROGRAM_ID,
            CalledItError::InvalidTxlineProgram
        );
        require_keys_eq!(
            *ctx.accounts.daily_scores_merkle_roots.owner,
            TXLINE_DEVNET_PROGRAM_ID,
            CalledItError::InvalidTxlineRootsAccount
        );
        require!(payload.ts >= 0, CalledItError::InvalidProofTimestamp);
        require!(
            payload.fixture_summary.fixture_id == pool.txline_fixture_id,
            CalledItError::FixtureDoesNotMatchPool
        );
        require!(
            payload.fixture_summary.update_stats.min_timestamp == payload.ts,
            CalledItError::InvalidProofTimestamp
        );
        require!(payload.stats.len() == 2, CalledItError::UnexpectedStats);
        require!(
            payload.stats[0].stat.key == 1
                && payload.stats[1].stat.key == 2
                && payload.stats[0].stat.period == 0
                && payload.stats[1].stat.period == 0,
            CalledItError::UnexpectedStats
        );
        require!(
            payload.stats[0].stat.value >= 0
                && payload.stats[1].stat.value >= 0
                && payload.stats[0].stat.value <= u8::MAX as i32
                && payload.stats[1].stat.value <= u8::MAX as i32,
            CalledItError::InvalidScore
        );

        let expected_roots = txline_daily_scores_roots(payload.ts)?;
        require_keys_eq!(
            ctx.accounts.daily_scores_merkle_roots.key(),
            expected_roots,
            CalledItError::InvalidTxlineRootsAccount
        );

        // Generate the strategy inside CalledIt. This ensures every provided
        // leaf is verified for exact equality, rather than accepting a caller-
        // selected predicate that could leave a score unconstrained.
        let strategy = exact_two_score_strategy(&payload)?;
        invoke_txline_validate_stat_v2(
            &payload,
            &strategy,
            &ctx.accounts.daily_scores_merkle_roots.to_account_info(),
            &ctx.accounts.txline_program.to_account_info(),
        )?;

        let participant1_goals = payload.stats[0].stat.value as u8;
        let participant2_goals = payload.stats[1].stat.value as u8;
        let (home_goals, away_goals) = if pool.participant1_is_home {
            (participant1_goals, participant2_goals)
        } else {
            (participant2_goals, participant1_goals)
        };

        pool.final_home_goals = home_goals;
        pool.final_away_goals = away_goals;
        pool.winning_stake_lamports = if home_goals <= MAX_SCORE && away_goals <= MAX_SCORE {
            pool.score_stakes[score_index(home_goals, away_goals)?]
        } else {
            0
        };
        pool.status = if pool.winning_stake_lamports == 0 {
            PoolStatus::Refunding
        } else {
            PoolStatus::Settled
        };

        emit!(PoolSettled {
            pool: pool.key(),
            final_home_goals: home_goals,
            final_away_goals: away_goals,
            winning_stake_lamports: pool.winning_stake_lamports,
            refunding: pool.status == PoolStatus::Refunding,
        });
        Ok(())
    }

    /// Emergency cancellation never transfers SOL to an operator. It only
    /// makes individual stake refunds claimable.
    pub fn cancel_pool(ctx: Context<CancelPool>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.emergency_authority.key(),
            ctx.accounts.config.emergency_authority,
            CalledItError::UnauthorizedEmergencyAuthority
        );
        require!(
            ctx.accounts.pool.status == PoolStatus::Open,
            CalledItError::PoolNotOpen
        );
        ctx.accounts.pool.status = PoolStatus::Refunding;
        emit!(PoolCancelled {
            pool: ctx.accounts.pool.key(),
        });
        Ok(())
    }

    /// Winners or refund-eligible entrants pull their own SOL. Payouts use
    /// deterministic floor division, so aggregate claims can never exceed the
    /// pool's recorded stake balance.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let entry = &mut ctx.accounts.entry;
        require!(!entry.claimed, CalledItError::AlreadyClaimed);
        require!(
            pool.status == PoolStatus::Settled || pool.status == PoolStatus::Refunding,
            CalledItError::PoolNotClaimable
        );

        let payout = if pool.status == PoolStatus::Refunding {
            entry.stake_lamports
        } else {
            require!(
                entry.home_goals == pool.final_home_goals
                    && entry.away_goals == pool.final_away_goals,
                CalledItError::NotWinningEntry
            );
            require!(
                pool.winning_stake_lamports > 0,
                CalledItError::PoolNotClaimable
            );
            ((entry.stake_lamports as u128)
                .checked_mul(pool.total_stake_lamports as u128)
                .ok_or(CalledItError::ArithmeticOverflow)?
                .checked_div(pool.winning_stake_lamports as u128)
                .ok_or(CalledItError::ArithmeticOverflow)?)
            .try_into()
            .map_err(|_| error!(CalledItError::ArithmeticOverflow))?
        };

        let vault_info = ctx.accounts.vault.to_account_info();
        let player_info = ctx.accounts.player.to_account_info();
        let available = vault_info
            .lamports()
            .checked_sub(pool.vault_rent_lamports)
            .ok_or(CalledItError::InsufficientVaultBalance)?;
        require!(available >= payout, CalledItError::InsufficientVaultBalance);

        {
            let mut vault_lamports = vault_info.try_borrow_mut_lamports()?;
            **vault_lamports = (**vault_lamports)
                .checked_sub(payout)
                .ok_or(CalledItError::InsufficientVaultBalance)?;
        }
        {
            let mut player_lamports = player_info.try_borrow_mut_lamports()?;
            **player_lamports = (**player_lamports)
                .checked_add(payout)
                .ok_or(CalledItError::ArithmeticOverflow)?;
        }

        entry.claimed = true;
        pool.claimed_lamports = pool
            .claimed_lamports
            .checked_add(payout)
            .ok_or(CalledItError::ArithmeticOverflow)?;
        emit!(Claimed {
            pool: pool.key(),
            player: entry.player,
            payout_lamports: payout,
            refund: pool.status == PoolStatus::Refunding,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = MarketConfig::SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, MarketConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub current_authority: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, MarketConfig>,
}

#[derive(Accounts)]
pub struct EmergencyConfig<'info> {
    pub emergency_authority: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, MarketConfig>,
}

#[derive(Accounts)]
#[instruction(pool_seed: [u8; 32])]
pub struct CreatePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, MarketConfig>,
    #[account(init, payer = authority, space = MarketPool::SPACE, seeds = [b"pool", pool_seed.as_ref()], bump)]
    pub pool: Account<'info, MarketPool>,
    #[account(init, payer = authority, space = Vault::SPACE, seeds = [b"vault", pool.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EnterPool<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, MarketConfig>,
    #[account(mut, seeds = [b"pool", pool.seed.as_ref()], bump = pool.bump, has_one = config, has_one = vault)]
    pub pool: Account<'info, MarketPool>,
    #[account(mut, seeds = [b"vault", pool.key().as_ref()], bump = pool.vault_bump, has_one = pool)]
    pub vault: Account<'info, Vault>,
    #[account(init, payer = player, space = MarketEntry::SPACE, seeds = [b"entry", pool.key().as_ref(), player.key().as_ref()], bump)]
    pub entry: Account<'info, MarketEntry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleWithTxlineProof<'info> {
    pub settlement_authority: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, MarketConfig>,
    #[account(mut, seeds = [b"pool", pool.seed.as_ref()], bump = pool.bump, has_one = config)]
    pub pool: Account<'info, MarketPool>,
    /// CHECK: verified against TxLINE's published devnet ID and used only for CPI.
    pub txline_program: UncheckedAccount<'info>,
    /// CHECK: address and owner are derived/validated before CPI.
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CancelPool<'info> {
    pub emergency_authority: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, MarketConfig>,
    #[account(mut, seeds = [b"pool", pool.seed.as_ref()], bump = pool.bump, has_one = config)]
    pub pool: Account<'info, MarketPool>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(mut, seeds = [b"pool", pool.seed.as_ref()], bump = pool.bump, has_one = vault)]
    pub pool: Account<'info, MarketPool>,
    #[account(mut, seeds = [b"vault", pool.key().as_ref()], bump = pool.vault_bump, has_one = pool)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [b"entry", pool.key().as_ref(), player.key().as_ref()], bump = entry.bump, has_one = pool, has_one = player)]
    pub entry: Account<'info, MarketEntry>,
}

#[account]
pub struct MarketConfig {
    pub authority: Pubkey,
    pub settlement_authority: Pubkey,
    pub emergency_authority: Pubkey,
    pub stake_lamports: u64,
    pub max_entries: u16,
    pub paused: bool,
    pub bump: u8,
}

impl MarketConfig {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 8 + 2 + 1 + 1;
}

#[account]
pub struct MarketPool {
    pub config: Pubkey,
    pub vault: Pubkey,
    pub seed: [u8; 32],
    pub txline_fixture_id: i64,
    pub participant1_is_home: bool,
    pub lock_at: i64,
    pub stake_lamports: u64,
    pub max_entries: u16,
    pub entry_count: u16,
    pub total_stake_lamports: u64,
    pub score_stakes: Vec<u64>,
    pub final_home_goals: u8,
    pub final_away_goals: u8,
    pub winning_stake_lamports: u64,
    pub claimed_lamports: u64,
    pub vault_rent_lamports: u64,
    pub status: PoolStatus,
    pub bump: u8,
    pub vault_bump: u8,
}

impl MarketPool {
    pub const SPACE: usize = 8
        + 32
        + 32
        + 32
        + 8
        + 1
        + 8
        + 8
        + 2
        + 2
        + 8
        + 4
        + (8 * SCORE_BUCKETS)
        + 1
        + 1
        + 8
        + 8
        + 8
        + 1
        + 1
        + 1;
}

#[account]
pub struct Vault {
    pub pool: Pubkey,
    pub bump: u8,
}

impl Vault {
    pub const SPACE: usize = 8 + 32 + 1;
}

#[account]
pub struct MarketEntry {
    pub pool: Pubkey,
    pub player: Pubkey,
    pub home_goals: u8,
    pub away_goals: u8,
    pub stake_lamports: u64,
    pub claimed: bool,
    pub bump: u8,
}

impl MarketEntry {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 1 + 8 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum PoolStatus {
    Open,
    Settled,
    Refunding,
}

/// Mirrors the public TxLINE devnet IDL types for `validate_stat_v2`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TxlineProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TxlineScoreStat {
    pub key: u32,
    pub value: i32,
    pub period: i32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TxlineScoresUpdateStats {
    pub update_count: i32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TxlineScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: TxlineScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TxlineStatLeaf {
    pub stat: TxlineScoreStat,
    pub stat_proof: Vec<TxlineProofNode>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TxlineStatValidationInput {
    pub ts: i64,
    pub fixture_summary: TxlineScoresBatchSummary,
    pub fixture_proof: Vec<TxlineProofNode>,
    pub main_tree_proof: Vec<TxlineProofNode>,
    pub event_stat_root: [u8; 32],
    pub stats: Vec<TxlineStatLeaf>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum TxlineComparison {
    GreaterThan,
    LessThan,
    EqualTo,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TxlineTraderPredicate {
    pub threshold: i32,
    pub comparison: TxlineComparison,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum TxlineBinaryExpression {
    Add,
    Subtract,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum TxlineStatPredicate {
    Single {
        index: u8,
        predicate: TxlineTraderPredicate,
    },
    Binary {
        index_a: u8,
        index_b: u8,
        op: TxlineBinaryExpression,
        predicate: TxlineTraderPredicate,
    },
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TxlineGeometricTarget {
    pub stat_index: u8,
    pub prediction: i32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TxlineNDimensionalStrategy {
    pub geometric_targets: Vec<TxlineGeometricTarget>,
    pub distance_predicate: Option<TxlineTraderPredicate>,
    pub discrete_predicates: Vec<TxlineStatPredicate>,
}

fn score_index(home_goals: u8, away_goals: u8) -> Result<usize> {
    require!(
        home_goals <= MAX_SCORE && away_goals <= MAX_SCORE,
        CalledItError::InvalidScore
    );
    Ok(home_goals as usize * SCORE_BUCKET_SIDE + away_goals as usize)
}

fn txline_daily_scores_roots(timestamp_ms: i64) -> Result<Pubkey> {
    require!(timestamp_ms >= 0, CalledItError::InvalidProofTimestamp);
    let epoch_day = (timestamp_ms as u64)
        .checked_div(86_400_000)
        .ok_or(CalledItError::InvalidProofTimestamp)?;
    require!(
        epoch_day <= u16::MAX as u64,
        CalledItError::InvalidProofTimestamp
    );
    Ok(Pubkey::find_program_address(
        &[b"daily_scores_roots", &(epoch_day as u16).to_le_bytes()],
        &TXLINE_DEVNET_PROGRAM_ID,
    )
    .0)
}

fn exact_two_score_strategy(
    payload: &TxlineStatValidationInput,
) -> Result<TxlineNDimensionalStrategy> {
    require!(payload.stats.len() == 2, CalledItError::UnexpectedStats);
    Ok(TxlineNDimensionalStrategy {
        geometric_targets: vec![],
        distance_predicate: None,
        discrete_predicates: vec![
            TxlineStatPredicate::Single {
                index: 0,
                predicate: TxlineTraderPredicate {
                    threshold: payload.stats[0].stat.value,
                    comparison: TxlineComparison::EqualTo,
                },
            },
            TxlineStatPredicate::Single {
                index: 1,
                predicate: TxlineTraderPredicate {
                    threshold: payload.stats[1].stat.value,
                    comparison: TxlineComparison::EqualTo,
                },
            },
        ],
    })
}

fn invoke_txline_validate_stat_v2<'info>(
    payload: &TxlineStatValidationInput,
    strategy: &TxlineNDimensionalStrategy,
    daily_scores_merkle_roots: &AccountInfo<'info>,
    txline_program: &AccountInfo<'info>,
) -> Result<()> {
    // Public TxLINE devnet IDL discriminator for `validate_stat_v2`.
    const DISCRIMINATOR: [u8; 8] = [208, 215, 194, 214, 241, 71, 246, 178];
    let mut data = DISCRIMINATOR.to_vec();
    data.extend(payload.try_to_vec()?);
    data.extend(strategy.try_to_vec()?);
    let instruction = Instruction {
        program_id: TXLINE_DEVNET_PROGRAM_ID,
        accounts: vec![AccountMeta::new_readonly(
            *daily_scores_merkle_roots.key,
            false,
        )],
        data,
    };
    invoke(
        &instruction,
        &[daily_scores_merkle_roots.clone(), txline_program.clone()],
    )?;

    let (program_id, data) = get_return_data().ok_or(error!(CalledItError::TxlineDidNotReturn))?;
    require_keys_eq!(
        program_id,
        TXLINE_DEVNET_PROGRAM_ID,
        CalledItError::TxlineDidNotReturn
    );
    let validated =
        bool::try_from_slice(&data).map_err(|_| error!(CalledItError::TxlineDidNotReturn))?;
    require!(validated, CalledItError::TxlineProofRejected);
    Ok(())
}

#[event]
pub struct PoolCreated {
    pub pool: Pubkey,
    pub txline_fixture_id: i64,
    pub lock_at: i64,
    pub stake_lamports: u64,
}

#[event]
pub struct EntryPlaced {
    pub pool: Pubkey,
    pub player: Pubkey,
    pub home_goals: u8,
    pub away_goals: u8,
    pub stake_lamports: u64,
}

#[event]
pub struct PoolSettled {
    pub pool: Pubkey,
    pub final_home_goals: u8,
    pub final_away_goals: u8,
    pub winning_stake_lamports: u64,
    pub refunding: bool,
}

#[event]
pub struct PoolCancelled {
    pub pool: Pubkey,
}

#[event]
pub struct Claimed {
    pub pool: Pubkey,
    pub player: Pubkey,
    pub payout_lamports: u64,
    pub refund: bool,
}

#[error_code]
pub enum CalledItError {
    #[msg("Only the configured bootstrap wallet may initialize this deployment")]
    UnauthorizedBootstrapAuthority,
    #[msg("Only the configured authority may perform this action")]
    UnauthorizedAuthority,
    #[msg("Only the configured settlement authority may submit a final score proof")]
    UnauthorizedSettlementAuthority,
    #[msg("Only the configured emergency authority may perform this action")]
    UnauthorizedEmergencyAuthority,
    #[msg("The configured fixed stake must be positive")]
    InvalidStake,
    #[msg("The maximum entry count must be positive")]
    InvalidMaxEntries,
    #[msg("The market is paused")]
    ProgramPaused,
    #[msg("The pool is not open for this action")]
    PoolNotOpen,
    #[msg("Predictions are locked for this pool")]
    PredictionsLocked,
    #[msg("The finalisation proof cannot be submitted before lock time")]
    PredictionsStillOpen,
    #[msg("The pool has reached its entry limit")]
    PoolFull,
    #[msg("Score must be within the supported range")]
    InvalidScore,
    #[msg("The TxLINE fixture ID is invalid")]
    InvalidFixture,
    #[msg("The pool lock time is invalid")]
    InvalidLockTime,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("The pool is not ready for a claim")]
    PoolNotClaimable,
    #[msg("This entry is not an exact-score winner")]
    NotWinningEntry,
    #[msg("This entry has already been claimed")]
    AlreadyClaimed,
    #[msg("The vault cannot cover this claim")]
    InsufficientVaultBalance,
    #[msg("The supplied TxLINE program is not the documented devnet program")]
    InvalidTxlineProgram,
    #[msg("The supplied TxLINE daily scores roots account is invalid")]
    InvalidTxlineRootsAccount,
    #[msg("The proof timestamp is invalid")]
    InvalidProofTimestamp,
    #[msg("The proof fixture does not match this pool")]
    FixtureDoesNotMatchPool,
    #[msg("The proof must contain exactly participant 1 and participant 2 total goals")]
    UnexpectedStats,
    #[msg("TxLINE did not return a validation result")]
    TxlineDidNotReturn,
    #[msg("TxLINE rejected the supplied proof")]
    TxlineProofRejected,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn score_buckets_cover_the_configured_range() {
        assert_eq!(score_index(0, 0).unwrap(), 0);
        assert_eq!(
            score_index(MAX_SCORE, MAX_SCORE).unwrap(),
            SCORE_BUCKETS - 1
        );
        assert!(score_index(MAX_SCORE + 1, 0).is_err());
    }

    #[test]
    fn derives_txline_daily_scores_pda_from_proof_timestamp() {
        let timestamp_ms = 1_720_000_000_000i64;
        let expected_epoch_day = (timestamp_ms / 86_400_000) as u16;
        let expected = Pubkey::find_program_address(
            &[b"daily_scores_roots", &expected_epoch_day.to_le_bytes()],
            &TXLINE_DEVNET_PROGRAM_ID,
        )
        .0;
        assert_eq!(txline_daily_scores_roots(timestamp_ms).unwrap(), expected);
    }
}
