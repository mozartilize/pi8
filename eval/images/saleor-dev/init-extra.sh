# Starts PostgreSQL for the Saleor tests. It runs as root before the sandbox daemon starts.
mkdir -p /dev/shm && mount -t tmpfs -o mode=1777 tmpfs /dev/shm 2>/dev/null || chmod 1777 /dev/shm
mkdir -p /var/run/postgresql && chown postgres:postgres /var/run/postgresql
su postgres -c "/usr/lib/postgresql/17/bin/pg_ctl -D /var/lib/postgresql/17/main -o '-c config_file=/etc/postgresql/17/main/postgresql.conf' -l /var/lib/postgresql/server.log -w start" || true
