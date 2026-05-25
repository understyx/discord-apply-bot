# discord-apply-bot

Discord bot that supports a guild application workflow:

1. Officers configure application name + questions with `/setquestions` (modal form)
2. Officers post an embed with `/postapply`
3. Bot creates a private channel in **Applications (Pending)** for applicant + officers
4. Bot posts the configured questions in the created private channel
5. Officers run `/approve` or `/deny`
6. Bot moves the channel to **Applications (Approved)** or **Applications (Denied)**

## Setup

```bash
npm install
```

Create `.env`:

```env
DISCORD_TOKEN=your_token_here
OFFICER_ROLE_NAME=Officer
APPLICATIONS_PENDING_CATEGORY=Applications (Pending)
APPLICATIONS_APPROVED_CATEGORY=Applications (Approved)
APPLICATIONS_DENIED_CATEGORY=Applications (Denied)
APPLY_APPLICATION_NAME=Guild Application
APPLY_QUESTIONS=Tell us your character name, class/spec, and raid experience.
```

Run:

```bash
npm start
```

## Commands

- `/setquestions` — opens a modal to set application name + questions
- `/postapply` — posts the embed with application buttons
- `/approve` — move current application channel to approved category
- `/deny` — move current application channel to denied category