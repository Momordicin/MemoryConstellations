// pm2 进程配置 —— `pm2 start ecosystem.config.js`
//
// 记忆管线是常驻后台循环（Archivist 每 2 分钟一个 tick，Scribe 每 5 分钟敲门），
// 所以要用 pm2 这类进程管理器跑，别挂在某个请求上。
// .env 由 index.js 里的 dotenv 读取，cwd 就是本目录，不用另外配。
module.exports = {
  apps: [{
    name: 'memory-constellations',
    script: 'index.js',
    // 崩溃保护：指数退避 + 上限停止，避免坏配置下无限重启刷日志
    min_uptime: 10000,               // 10 秒内崩溃视为不稳定
    max_restarts: 10,                // 10 次不稳定重启后永久停止
    restart_delay: 3000,             // 最短间隔 3 秒
    exp_backoff_restart_delay: 5000, // 首次等 5 秒，之后翻倍
    // SIGKILL 延迟放宽到 12 秒：给 SQLite 留出 WAL checkpoint 的时间
    // （默认 1600ms 太短，进程被硬杀时容易留下 -wal/-shm 残留）
    kill_timeout: 12000,
    env: {
      NODE_ENV: 'production',
    },
  }],
};
