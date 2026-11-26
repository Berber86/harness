import { createAppServer } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const server = createAppServer();

server.listen(port, '0.0.0.0', () => {
  console.log(`Мой помощник открыт: http://localhost:${port}`);
});
