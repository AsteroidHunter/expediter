// Browser-only token helpers. The token is set by the inline <script> in
// src/app.html (which reads location.hash and stashes the value), and read +
// cleared by src/routes/+page.svelte. Never import from a server file — the
// sessionStorage reference would crash at SSR time.

const KEY = 'expediter-token';

export function getClientToken(): string | null {
	if (typeof sessionStorage === 'undefined') return null;
	try {
		return sessionStorage.getItem(KEY);
	} catch {
		return null;
	}
}

export function clearClientToken(): void {
	if (typeof sessionStorage === 'undefined') return;
	try {
		sessionStorage.removeItem(KEY);
	} catch {
		/* nothing to do — the absence is the goal */
	}
}
