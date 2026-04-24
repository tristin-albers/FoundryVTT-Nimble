export const COMBAT_READINESS_ENABLED_SETTING_KEY = 'combatReadinessEnabled';

export function registerCombatReadinessSettings(): void {
	game.settings.register(
		'nimble' as 'core',
		COMBAT_READINESS_ENABLED_SETTING_KEY as 'rollMode',
		{
			name: 'NIMBLE.settings.combatReadiness.name',
			hint: 'NIMBLE.settings.combatReadiness.hint',
			scope: 'world',
			config: true,
			type: Boolean,
			default: false,
			requiresReload: true,
		} as unknown as Parameters<typeof game.settings.register>[2],
	);
}

export function isCombatReadinessEnabled(): boolean {
	const settings = game.settings?.settings as { has: (key: string) => boolean } | undefined;
	if (!settings?.has(`nimble.${COMBAT_READINESS_ENABLED_SETTING_KEY}`)) return false;
	return Boolean(
		game.settings.get('nimble' as 'core', COMBAT_READINESS_ENABLED_SETTING_KEY as 'rollMode'),
	);
}
