# discord-apply-bot

Discord bot that supports a guild application workflow:

1. Officers set the officer role with `/setofficerrole`
2. Officers configure questions for a specific application with `/setquestions`
3. Officers post an embed with `/postapply`
4. Applicants choose an application button
5. Bot creates a private channel in **Applications (Pending)** for applicant + officers
6. Bot posts the configured questions in the created private channel
7. Officers run `/approve` or `/deny`
8. Bot moves the channel to **Applications (Approved)** or **Applications (Denied)**

## Setup

Install dependencies:

```bash
npm install
```

Create `.env` with required values:

```env
DISCORD_TOKEN=your_token_here
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=discord_apply_bot
MYSQL_PASSWORD=your_password_here
MYSQL_DATABASE=discord_apply_bot
```

Run:

```bash
npm start
```

## Commands

- `/setofficerrole @role` — set the role that can manage applications
- `/setquestions application:<name>` — edit/create questions for one application
- `/postapply` — posts the embed with application buttons
- `/approve` — move current application channel to approved category
- `/deny` — move current application channel to denied category
