import { createAppServer } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const server = createAppServer();

// Allow a newly launched start.bat / start.command to replace an older instance cleanly.
server.on('request', (req) => {
  if (req.method === 'POST' && req.url === '/__shutdown') {
    const remote = req.socket.remoteAddress ?? '';
    if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') {
      setTimeout(() => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 500).unref();
      }, 30);
    }
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Мой помощник открыт: http://localhost:${port}`);
});
