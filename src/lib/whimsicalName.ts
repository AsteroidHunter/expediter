// Fallback display names for sessions that don't yet have a real chat title
// (e.g. brand-new sessions before Claude's auto-titler runs and the user hasn't
// /rename'd). Picked deterministically from session_id so the same session
// always renders the same name across daemon restarts and reconnects — no
// persistence needed.
export const WHIMSICAL_NAMES: readonly string[] = [
	'forgotten lighthouse',
	'neon truck stop',
	'haunted laundromat',
	'midnight observatory',
	'rusty pier',
	'drowsy bookshop',
	'feral parking lot',
	'lonely diner',
	'twilight bowling alley',
	'ghost ferry terminal',
	'abandoned arcade',
	'moonlit garage',
	'dusty motel',
	'peeling drive-in',
	'flickering payphone',
	'lost amusement park',
	'silent rest stop',
	'sunken pool hall',
	'quiet ice cream stand',
	'wandering greenhouse',
	'shuttered roadside zoo',
	'brittle awning',
	'moss-grown cabin',
	'windswept parking deck',
	'yawning tunnel',
	'paper-bag bodega',
	'tired vending machine',
	'derelict ferris wheel',
	'faded mini-golf',
	'echoing stairwell',
	'unmarked off-ramp',
	'crooked weather station',
	'sleeping crossing guard',
	'empty tollbooth',
	'overgrown rail crossing',
	'cracked rooftop pool',
	'broken jukebox lounge',
	'fogged terrarium',
	'distant cell tower',
	'wilted flower shop'
];

// FNV-1a 32-bit. Cheap, deterministic, well-distributed for short strings.
function fnv1a(str: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}

export function whimsicalName(sessionId: string): string {
	return WHIMSICAL_NAMES[fnv1a(sessionId) % WHIMSICAL_NAMES.length];
}
