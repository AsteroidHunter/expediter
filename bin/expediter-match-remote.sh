#!/bin/sh
# expediter-match-remote.sh <keys-file> <typed-name> <resolved-host> <port>
#
# ssh_config `Match exec` predicate for the expediter reverse tunnel (D18):
# exit 0 iff the destination of the CURRENT ssh invocation is the installed
# devbox, recognized by HOST KEY rather than by one spelling. The Mac's
# known_hosts is consulted for the name the user typed (%n) and the resolved
# hostname (%h), port-qualified forms included; the stored key blobs are
# compared verbatim against the keys recorded for the host at
# `expediter install remote <name>` time. Any spelling the Mac has ever
# connected to therefore matches automatically — alias, FQDN, bare IP — and
# a brand-new spelling misses exactly once (no known_hosts entry yet, so no
# tunnel that first time) and self-heals for every connection after.
#
# Runs on EVERY ssh-family invocation the user makes, so it must be fast and
# silent: two ssh-keygen lookups and a grep, no network, nothing printed.

keys_file="$1"
typed="$2"
resolved="$3"
port="$4"
# Optional 5th arg: a known_hosts file override for tests — ssh-keygen
# resolves ~ from the password database, so $HOME tricks can't redirect it.
# Production config lines pass four args and use the default files.
kh_override="${5:-}"

[ -f "$keys_file" ] || exit 1

lookup() {
	if [ -n "$kh_override" ]; then
		ssh-keygen -F "$1" -f "$kh_override" 2>/dev/null
	else
		ssh-keygen -F "$1" 2>/dev/null
	fi
}

for name in "$typed" "$resolved" "[$typed]:$port" "[$resolved]:$port"; do
	[ -n "$name" ] || continue
	# ssh-keygen -F answers hashed and plain entries alike; entry lines are
	# "<host-or-hash> <keytype> <base64> ...", comment lines start with '#'.
	# grep -f - takes the looked-up blobs as literal whole-line patterns
	# against the recorded keys file; an empty lookup matches nothing.
	if lookup "$name" \
		| awk '$1 !~ /^#/ && NF >= 3 { print $2 " " $3 }' \
		| grep -qxFf - "$keys_file" 2>/dev/null; then
		exit 0
	fi
done
exit 1
