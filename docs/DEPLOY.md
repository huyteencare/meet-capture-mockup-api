# Deployment & Operations

**Server:** `18.142.106.202` (Ubuntu 24.04, AWS ap-southeast-1)
**SSH key:** `~/.ssh/your_key_name.pem`

## SSH into server

```bash
ssh -i ~/.ssh/your_key_name.pem ubuntu@18.142.106.202
```

## Redeploy after local changes

Run from your local machine:

```bash
rsync -az --exclude 'node_modules' --exclude 'captures' \
  -e "ssh -i ~/.ssh/your_key_name.pem" \
  /home/huy/workspace/teencare/meet-capture-api/ \
  ubuntu@18.142.106.202:/home/ubuntu/meet-capture-api/

ssh -i ~/.ssh/your_key_name.pem ubuntu@18.142.106.202 "pm2 restart meet-capture-api"
```

## PM2 — process management

```bash
pm2 status                     # check if running
pm2 logs meet-capture-api      # live request logs (morgan + errors)
pm2 logs meet-capture-api --lines 200   # last 200 lines
pm2 restart meet-capture-api   # restart app
pm2 stop meet-capture-api      # stop app
pm2 delete meet-capture-api    # remove from PM2
```

## Health check

```bash
curl http://18.142.106.202/health
```

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server health + captures root path |
| POST | `/api/capture/batch` | Upload batch of capture events |
| GET | `/api/sessions` | List all recorded sessions |
| GET | `/api/sessions/:sessionId` | Get session detail + manifest |
| GET | `/captures/*` | Serve static capture files |

## Nginx

```bash
sudo systemctl status nginx          # check nginx status
sudo nginx -t                        # test config syntax
sudo systemctl reload nginx          # reload config (no downtime)
sudo tail -f /var/log/nginx/access.log   # nginx access log
sudo tail -f /var/log/nginx/error.log    # nginx error log
```

Config file: `/etc/nginx/sites-available/meet-capture-api`

## Captures data

Saved to `/home/ubuntu/meet-capture-api/captures/` on the server.

```bash
# Check disk usage
du -sh /home/ubuntu/meet-capture-api/captures/

# List sessions
ls /home/ubuntu/meet-capture-api/captures/
```
