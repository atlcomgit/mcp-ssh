# mcp-ssh

MCP сервер для подключения по SSH и выполнения команд на удалённом сервере.

## Быстрый старт

1) Установите зависимости:

- npm install

2) Создайте .env на основе .env.example и задайте параметры подключения.

3) Запустите в режиме разработки:

- npm run dev

Или соберите и запустите:

- npm run build
- npm start

## Запуск через docker-compose

1) Создайте .env на основе .env.example.

2) Запустите сервис:

- docker compose up -d

Сервис работает по stdio (MCP), проброс портов не требуется.

## Доступные инструменты MCP

### ssh_connect
Создаёт SSH сессию.

Параметры:
- host (string, optional)
- port (number, optional)
- username (string, optional)
- privateKey (string, optional)
- privateKeyPath (string, optional)
- password (string, optional)
- connectTimeoutMs (number, optional)

Возвращает: sessionId, host, port, username.

### ssh_exec
Выполняет команду в существующей сессии.

Параметры:
- sessionId (string)
- command (string)
- cwd (string, optional)
- timeoutMs (number, optional)

Возвращает: stdout, stderr, exitCode, exitSignal.

### ssh_disconnect
Закрывает сессию.

Параметры:
- sessionId (string)

Возвращает: disconnected.

### ssh_list_sessions
Возвращает список активных сессий.

## Ограничение хостов

Если задан MCP_SSH_ALLOWED_HOSTS, подключение разрешено только к хостам из списка.
