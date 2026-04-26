import {
	getCombatantZipperSide,
	getZipperCurrentSide,
	hasZipperActed,
	isZipperAwaitingSelection,
	isZipperInitiativeActive,
} from '../documents/combat/zipperTurnState.js';
import { requestZipperCombatantSelection } from '../utils/combatTurnActions.js';
import { isCombatantDead } from '../utils/isCombatantDead.js';
import { isCombatStarted } from '../utils/isCombatStarted.js';
import {
	getEffectiveMinionGroupLeader,
	getMinionGroupId,
	getMinionGroupSummaries,
} from '../utils/minionGrouping.js';

const ZIPPER_OVERLAY_KEY = '_nimbleZipperSelectionOverlay';
const ZIPPER_OVERLAY_CLICK_KEY = '_nimbleZipperSelectionClickHandler';

type TokenWithZipperOverlay = Token & {
	[ZIPPER_OVERLAY_KEY]?: PIXI.Container | null;
	[ZIPPER_OVERLAY_CLICK_KEY]?: (() => void) | null;
};

let didRegisterZipperTokenOverlay = false;

// ---------------------------------------------------------------------------
// Combat / scene helpers
// ---------------------------------------------------------------------------

function getCombatantSceneId(combatant: Combatant.Implementation): string | undefined {
	if (combatant.sceneId) return combatant.sceneId;
	if (combatant.token?.parent?.id) return combatant.token.parent.id;
	return undefined;
}

function getCombatForScene(sceneId: string): Combat | null {
	const activeCombat = game.combat;
	if (activeCombat?.active && activeCombat.scene?.id === sceneId) return activeCombat;

	const viewedCombat = game.combats.viewed ?? null;
	if (viewedCombat?.scene?.id === sceneId) return viewedCombat;

	return (
		game.combats.contents.find(
			(combat) =>
				combat.scene?.id === sceneId ||
				combat.combatants.contents.some((combatant) => getCombatantSceneId(combatant) === sceneId),
		) ?? null
	);
}

// ---------------------------------------------------------------------------
// Build set of token IDs eligible for selection overlay
// ---------------------------------------------------------------------------

function buildEligibleTokenIds(): Map<string, string> {
	// Returns Map<tokenId, combatantId>
	const eligibleMap = new Map<string, string>();

	if (!isZipperInitiativeActive()) return eligibleMap;

	const sceneId = canvas.scene?.id;
	if (!sceneId) return eligibleMap;

	const combat = getCombatForScene(sceneId);
	if (!combat || !isCombatStarted(combat)) return eligibleMap;
	if (!isZipperAwaitingSelection(combat)) return eligibleMap;

	const currentSide = getZipperCurrentSide(combat);
	const isGM = Boolean(game.user?.isGM);

	const combatantsForScene = combat.combatants.contents.filter(
		(combatant) => getCombatantSceneId(combatant) === sceneId,
	);
	const groupSummaries = getMinionGroupSummaries(combatantsForScene);
	const seenGroupIds = new Set<string>();

	for (const combatant of combatantsForScene) {
		if (!combatant.tokenId) continue;
		if (isCombatantDead(combatant)) continue;
		if (hasZipperActed(combatant)) continue;
		if (getCombatantZipperSide(combatant) !== currentSide) continue;

		// For minion groups, only show overlay on the group leader
		const groupId = getMinionGroupId(combatant);
		if (groupId) {
			if (seenGroupIds.has(groupId)) continue;
			seenGroupIds.add(groupId);
			const summary = groupSummaries.get(groupId);
			if (summary) {
				const leader = getEffectiveMinionGroupLeader(summary, { aliveOnly: true });
				if (leader && leader.id !== combatant.id) continue;
			}
		}

		// Players can only select tokens they own; GM sees all eligible on their side
		if (!isGM && !combatant.actor?.isOwner) continue;

		if (combatant.id) {
			eligibleMap.set(combatant.tokenId, combatant.id);
		}
	}

	return eligibleMap;
}

// ---------------------------------------------------------------------------
// PIXI overlay rendering
// ---------------------------------------------------------------------------

function removeOverlay(token: TokenWithZipperOverlay): void {
	const overlay = token[ZIPPER_OVERLAY_KEY];
	if (overlay) {
		overlay.parent?.removeChild(overlay);
		overlay.destroy({ children: true });
		token[ZIPPER_OVERLAY_KEY] = null;
	}

	const clickHandler = token[ZIPPER_OVERLAY_CLICK_KEY];
	if (clickHandler) {
		token.removeEventListener?.('pointerdown', clickHandler);
		token[ZIPPER_OVERLAY_CLICK_KEY] = null;
	}
}

function createOverlay(token: TokenWithZipperOverlay, combatantId: string): void {
	removeOverlay(token);

	const tokenSize = Math.max(1, Number(token.w ?? 1));
	const container = new PIXI.Container();
	container.eventMode = 'none';
	container.zIndex = 1020;

	// Green circle background
	const circleRadius = Math.max(14, Math.round(tokenSize * 0.18));
	const background = new PIXI.Graphics();
	background.beginFill(0x22c55e, 0.9);
	background.drawCircle(0, 0, circleRadius);
	background.endFill();
	background.lineStyle({ width: 2, color: 0xffffff, alpha: 0.9 });
	background.drawCircle(0, 0, circleRadius);

	// Checkmark text
	const fontSize = Math.max(12, Math.round(circleRadius * 1.1));
	const label = new PIXI.Text('\u2713', {
		fontFamily: 'Signika',
		fontSize,
		fontWeight: '700',
		fill: 0xffffff,
		align: 'center',
	});
	const rendererResolution = Number(
		canvas?.app?.renderer?.resolution ?? globalThis.devicePixelRatio ?? 1,
	);
	label.resolution = Math.max(2, Number.isFinite(rendererResolution) ? rendererResolution : 2);
	label.roundPixels = true;
	label.anchor.set(0.5, 0.5);

	container.addChild(background);
	container.addChild(label);

	// Position at bottom-center of token
	container.position.set(Math.round(tokenSize / 2), Math.round(tokenSize - circleRadius - 4));

	token.addChild(container);
	token[ZIPPER_OVERLAY_KEY] = container;

	// Click handler — make the whole token clickable for selection
	const combat = getCombatForScene(canvas.scene?.id ?? '');
	if (combat) {
		const clickHandler = () => {
			void requestZipperCombatantSelection({ combat, combatantId });
		};
		token.addEventListener?.('pointerdown', clickHandler);
		token[ZIPPER_OVERLAY_CLICK_KEY] = clickHandler;
	}
}

// ---------------------------------------------------------------------------
// Refresh logic
// ---------------------------------------------------------------------------

function refreshTokenOverlay(
	token: TokenWithZipperOverlay,
	eligibleMap: Map<string, string>,
): void {
	const tokenId = token.document?.id ?? '';
	const combatantId = tokenId ? eligibleMap.get(tokenId) : undefined;

	if (!combatantId) {
		removeOverlay(token);
		return;
	}

	createOverlay(token, combatantId);
}

function refreshAllTokenOverlays(): void {
	if (!canvas?.ready || !canvas?.tokens) return;

	const eligibleMap = buildEligibleTokenIds();
	for (const token of canvas.tokens.placeables) {
		refreshTokenOverlay(token as TokenWithZipperOverlay, eligibleMap);
	}
}

function clearAllTokenOverlays(): void {
	if (!canvas?.tokens) return;
	for (const token of canvas.tokens.placeables) {
		removeOverlay(token as TokenWithZipperOverlay);
	}
}

// ---------------------------------------------------------------------------
// Hook registration
// ---------------------------------------------------------------------------

export default function registerZipperTokenOverlay(): void {
	if (didRegisterZipperTokenOverlay) return;
	didRegisterZipperTokenOverlay = true;

	Hooks.on('canvasReady', () => {
		refreshAllTokenOverlays();
	});

	Hooks.on('canvasTearDown', () => {
		clearAllTokenOverlays();
	});

	Hooks.on('refreshToken', (token: Token) => {
		const eligibleMap = buildEligibleTokenIds();
		refreshTokenOverlay(token as TokenWithZipperOverlay, eligibleMap);
	});

	Hooks.on('updateCombat', () => {
		refreshAllTokenOverlays();
	});

	Hooks.on('deleteCombat', () => {
		clearAllTokenOverlays();
	});

	Hooks.on('createCombatant', () => {
		refreshAllTokenOverlays();
	});

	Hooks.on('updateCombatant', () => {
		refreshAllTokenOverlays();
	});

	Hooks.on('deleteCombatant', () => {
		refreshAllTokenOverlays();
	});
}
