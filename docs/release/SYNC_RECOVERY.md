# 同步服务恢复历史与压缩快照

运行时实体历史由 `recovery.py` 和 ADR-0017 管理。首次部署 API 0.9 时，数据库迁移 11 会为既有可恢复实体建立一次压缩基线；部署前必须先备份当前数据库。

## 创建一致性压缩快照

在同步服务代码目录执行，数据库和目标目录必须通过服务器私密配置提供：

```bash
python3 backup_recovery.py \
  --database "$SYNC_DB_PATH" \
  --destination "$SYNC_BACKUP_DIR" \
  --keep-daily 7 \
  --keep-weekly 4 \
  --keep-monthly 12
```

脚本使用 SQLite Online Backup API，不要求服务器安装 `sqlite3` 命令；快照通过 `PRAGMA quick_check` 后才压缩发布，同时生成同名 `.sha256`。任何 `.partial` 文件都不是可用恢复点。

生产环境应由 systemd timer 或 cron 每日运行，并把完成的 `.db.gz` 与 `.sha256` 上传到 OSS/COS 等独立故障域。仓库不保存真实桶名、Access Key、SSH 地址或服务器路径。

## 抽样验证

定期在独立临时目录执行：

1. 校验 `.sha256`；
2. gzip 解压为临时数据库；
3. 用 Python `sqlite3` 执行 `PRAGMA quick_check`，结果必须为 `ok`；
4. 只核对实体数量、迁移版本和脱敏测试账号，不输出用户 payload；
5. 验证完成后安全删除临时解压文件。

## 逻辑时间点恢复

- `GET /sync/recovery/status` 查询当前账号的可恢复窗口和压缩率；
- `POST /sync/recovery/restore` 需要有效令牌、登录密码、`confirm: true`、当前 `data_generation` 和目标服务端毫秒时间；
- 成功后所有令牌撤销，客户端必须重新登录并先拉取；
- 主动清除云端或永久删除账号不会保留可恢复历史。