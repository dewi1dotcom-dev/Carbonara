# Caddy with Carbonara's Caddyfile built in. A bind mount of the file (./caddy/Caddyfile) failed under
# Portainer's Git stacks: the relative path didn't exist on the server, Docker made an empty folder
# there, and the container could never start ("created"). Built into the image, it always matches the repo.
FROM caddy:2.8.4-alpine
COPY Caddyfile /etc/caddy/Caddyfile
# start.sh: the server address from the System page (shared caddy_host volume), followed without a restart.
# sed: a checkout on Windows may have given the script CRLF line endings, which sh can't run.
COPY start.sh /usr/local/bin/carbonara-caddy
RUN sed -i 's/\r$//' /usr/local/bin/carbonara-caddy && chmod +x /usr/local/bin/carbonara-caddy
CMD ["/usr/local/bin/carbonara-caddy"]
