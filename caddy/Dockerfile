# Caddy with Carbonara's Caddyfile built in. A bind mount of the file (./caddy/Caddyfile) failed under
# Portainer's Git stacks: the relative path didn't exist on the server, Docker made an empty folder
# there, and the container could never start ("created"). Built into the image, it always matches the repo.
FROM caddy:2.8.4-alpine
COPY Caddyfile /etc/caddy/Caddyfile
