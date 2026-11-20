#!/bin/sh
# Starts Caddy with the server address staff type (the name its certificate is made for), and follows
# changes to it without a restart (0.39.0).
#
# The address comes from (1) the file the app writes into the shared caddy_host volume = System page
# → HTTPS → "Server address" (saved in the database, so it survives every redeploy and each location
# sets its own), else (2) CARBONARA_HOST from the stack, else (3) localhost.
FALLBACK="${CARBONARA_HOST:-localhost}"
HOST_FILE=/carbonara/host
CONFIG="--config /etc/caddy/Caddyfile --adapter caddyfile"

current() {
	# Only letters, digits, dots and hyphens (an IP address or a host name), so nothing else reaches the config.
	h=$(tr -cd 'A-Za-z0-9.-' < "$HOST_FILE" 2>/dev/null)
	echo "${h:-$FALLBACK}"
}

HOST=$(current)
echo "carbonara: HTTPS server address $HOST"
CARBONARA_HOST="$HOST" caddy run $CONFIG &
PID=$!
trap 'kill -TERM "$PID" 2>/dev/null; wait "$PID"; exit 0' TERM INT

FAILED=""
while kill -0 "$PID" 2>/dev/null; do
	sleep 10 & wait $!
	NEW=$(current)
	if [ "$NEW" != "$HOST" ] && [ "$NEW" != "$FAILED" ]; then
		# The Caddyfile is read again by this command, with the new address in its environment.
		if CARBONARA_HOST="$NEW" caddy reload $CONFIG; then
			echo "carbonara: HTTPS server address changed to $NEW"
			HOST="$NEW"; FAILED=""
		else
			echo "carbonara: could not change the HTTPS server address to $NEW; keeping $HOST"
			FAILED="$NEW"
		fi
	fi
done
wait "$PID"  # Caddy stopped by itself: the container stops and Docker restarts it
