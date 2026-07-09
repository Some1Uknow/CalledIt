use anchor_lang::prelude::*;

declare_id!("Ca11ed1111111111111111111111111111111111111");

#[program]
pub mod calledit_receipts {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>, authority: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = authority;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn update_authority(ctx: Context<UpdateAuthority>, new_authority: Pubkey) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.config.authority,
            CalledItError::UnauthorizedAuthority
        );
        ctx.accounts.config.authority = new_authority;
        Ok(())
    }

    pub fn record_receipt(
        ctx: Context<RecordReceipt>,
        pool_id: String,
        txline_fixture_id: String,
        final_home_goals: u8,
        final_away_goals: u8,
        receipt_hash: [u8; 32],
    ) -> Result<()> {
        require!(pool_id.len() <= Receipt::MAX_POOL_ID_LEN, CalledItError::PoolIdTooLong);
        require!(
            txline_fixture_id.len() <= Receipt::MAX_FIXTURE_ID_LEN,
            CalledItError::FixtureIdTooLong
        );
        require!(final_home_goals <= 30, CalledItError::InvalidScore);
        require!(final_away_goals <= 30, CalledItError::InvalidScore);
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.config.authority,
            CalledItError::UnauthorizedAuthority
        );

        let receipt = &mut ctx.accounts.receipt;
        receipt.authority = ctx.accounts.authority.key();
        receipt.pool_id = pool_id;
        receipt.txline_fixture_id = txline_fixture_id;
        receipt.final_home_goals = final_home_goals;
        receipt.final_away_goals = final_away_goals;
        receipt.receipt_hash = receipt_hash;
        receipt.recorded_at = Clock::get()?.unix_timestamp;
        receipt.bump = ctx.bumps.receipt;

        emit!(ReceiptRecorded {
            receipt: receipt.key(),
            authority: receipt.authority,
            final_home_goals,
            final_away_goals,
            receipt_hash,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = ReceiptConfig::SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, ReceiptConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateAuthority<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, ReceiptConfig>,
}

#[derive(Accounts)]
#[instruction(pool_id: String)]
pub struct RecordReceipt<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, ReceiptConfig>,
    #[account(
        init,
        payer = authority,
        space = Receipt::SPACE,
        seeds = [b"receipt", pool_id.as_bytes()],
        bump
    )]
    pub receipt: Account<'info, Receipt>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct ReceiptConfig {
    pub authority: Pubkey,
    pub bump: u8,
}

impl ReceiptConfig {
    pub const SPACE: usize = 8 + 32 + 1;
}

#[account]
pub struct Receipt {
    pub authority: Pubkey,
    pub pool_id: String,
    pub txline_fixture_id: String,
    pub final_home_goals: u8,
    pub final_away_goals: u8,
    pub receipt_hash: [u8; 32],
    pub recorded_at: i64,
    pub bump: u8,
}

impl Receipt {
    pub const MAX_POOL_ID_LEN: usize = 64;
    pub const MAX_FIXTURE_ID_LEN: usize = 96;
    pub const SPACE: usize = 8
        + 32
        + 4
        + Self::MAX_POOL_ID_LEN
        + 4
        + Self::MAX_FIXTURE_ID_LEN
        + 1
        + 1
        + 32
        + 8
        + 1;
}

#[event]
pub struct ReceiptRecorded {
    pub receipt: Pubkey,
    pub authority: Pubkey,
    pub final_home_goals: u8,
    pub final_away_goals: u8,
    pub receipt_hash: [u8; 32],
}

#[error_code]
pub enum CalledItError {
    #[msg("Pool id is too long")]
    PoolIdTooLong,
    #[msg("TxLINE fixture id is too long")]
    FixtureIdTooLong,
    #[msg("Score is outside the accepted football range")]
    InvalidScore,
    #[msg("Signer is not the configured receipt authority")]
    UnauthorizedAuthority,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipt_space_covers_expected_fields() {
        assert!(Receipt::SPACE > 190);
    }

    #[test]
    fn config_space_covers_expected_fields() {
        assert_eq!(ReceiptConfig::SPACE, 41);
    }
}
