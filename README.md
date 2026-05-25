# discord-apply-bot

Discord bot that supports a guild application workflow:

1. Officers set application questions with a simple text command
2. Applicants click **Apply**
3. Bot creates a private channel in **Applications (Pending)** for applicant + officers
4. Officers run `!approve` or `!deny`
5. Bot moves the channel to **Applications (Approved)** or **Applications (Denied)**

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
APPLY_QUESTIONS=Tell us your character name, class/spec, and raid experience.
```

Run:

```bash
npm start
```

## Commands

- `!setquestions <text>` — set guild application questions
- `!postapply` — post the message with the **Apply** button
- `!approve` — move application channel to approved category
- `!deny` — move application channel to denied category