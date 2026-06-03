---
name: deploy
description: Deploy, sync, push code to VPS production server for meet-capture-api. Use when asked to deploy, sync, push, release, or ship meet-capture-api to the server.
---

Deploy meet-capture-api lên VPS `160.191.244.71` bằng rsync + pm2 restart. Chạy từ thư mục `meet-capture-api/`.

## Agent path

```bash
cd /home/huy/workspace/teencare/meet-capture-api
npm run deploy
```

Lệnh này:
1. rsync toàn bộ source (trừ `node_modules`, `captures`, `.env`, `reports`, `benchmark-*.csv`) lên `/home/projects/meet-capture-api/`
2. `npm install --omit=dev` trên VPS
3. `pm2 restart meet-capture-api`

Output thành công kết thúc bằng:
```
[PM2] [meet-capture-api](0) ✓
│ status    │
│ online    │
```

## Verify sau deploy

```bash
ssh -i ~/.ssh/id_ed25519 root@160.191.244.71 "curl -s http://localhost:3000/health"
# → {"ok":true,"capturesRoot":"..."}
```

## Gotchas

- `.env` **không** được sync — file đó đã có sẵn trên VPS, không bao giờ ghi đè
- `captures/` không sync — data recording ở trên VPS, không đụng vào
- SSH key: `~/.ssh/id_ed25519` — phải có file này
- PM2 process tên `meet-capture-api` — nếu chưa tồn tại thì `pm2 restart` sẽ fail; dùng `pm2 start` lần đầu
