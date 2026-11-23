# Telegram Local Bot API — Render deployment

This project runs the official Telegram Bot API engine with a Node.js gateway.
Render builds the Docker image for you; you do not need to run Docker commands
on your own device.

## Features

- Official Telegram Local Bot API in `--local` mode.
- Node.js gateway streams requests to Telegram without buffering whole videos.
- Maximum incoming HTTP request body configured to 210 MiB.
- `/health` endpoint for Render.
- Protected `/cleanup` endpoint deletes exact temporary file paths immediately.
- No permanent video archive is configured. The container filesystem is
  ephemeral on Render Free and files may disappear on restart/redeploy.

Telegram's official Local Bot API supports uploads up to 2000 MB and returns
absolute local file paths from `getFile` in local mode. This service's gateway
is configured for 210 MiB request bodies to match the requested 200 MB video
workflow. Actual success depends on Render's available RAM/disk and request
routing; test with real 200 MB files.

## Deploy to Render

1. Upload all files in this repository to your GitHub repository.
2. In Render, select **New > Blueprint** and connect this GitHub repository.
3. Render detects `render.yaml` and creates the Docker web service.
4. Add `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` in the Render Environment tab.
5. Render generates `CLEANUP_TOKEN`. Copy it securely; do not publish it.
6. Deploy. Open `https://YOUR-SERVICE.onrender.com/health`; expect JSON with
   `"ok":true`.

## Required bot integration for immediate deletion

The API server cannot know when a separate bot has finished its processing
method. Your bot must call `/cleanup` after it has finished using the file.

In local Bot API mode, `getFile` returns an absolute `file_path` on the API
server. Keep that exact path in your job record. After the processing method
finishes (whether it succeeds or throws), call:

```http
POST https://YOUR-SERVICE.onrender.com/cleanup
Content-Type: application/json
X-Cleanup-Token: YOUR_CLEANUP_TOKEN

{"paths":["/tmp/telegram-bot-api-data/.../file.mp4"]}
```

The server immediately deletes the listed regular file(s), but only if their
paths are inside the configured Telegram work or temporary directory. It
rejects paths outside those directories. You may submit up to 100 paths.

Your bot must also delete its own downloaded/processed temporary copies on its
own machine after processing. Deleting the Telegram server's copy does not
delete the bot server's separate copy.

### Node.js bot callback example

```js
async function tellApiToDelete(apiBaseUrl, cleanupToken, filePaths) {
  const response = await fetch(`${apiBaseUrl}/cleanup`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-cleanup-token': cleanupToken
    },
    body: JSON.stringify({ paths: filePaths })
  });

  if (!response.ok) {
    throw new Error(`Remote cleanup failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

// Call in finally, after processing has stopped using the input/output files:
// await tellApiToDelete(process.env.TELEGRAM_API_ROOT,
//   process.env.TELEGRAM_API_CLEANUP_TOKEN, [telegramFilePath]);
```

For reliable cleanup, put this call in a `finally` block in your bot's job
handler, after all file handles/streams are closed. Do not delete a file while
the processing method still needs it.

## Important Render Free limitations

Render Free services have 512 MB RAM, spin down when idle, and use ephemeral
filesystem storage. This can make large or concurrent video jobs unreliable.
A 200 MB request ceiling is configured here; it is not a promise that the free
instance can process every 200 MB upload. Do not use this free service for
production-critical large uploads without load testing and suitable resources.

The API server is intended to be private to your bot. Keep the service URL and
cleanup token out of public client-side code. Protect the Bot API access with
an authentication layer or private networking before exposing it to untrusted
users; this starter uses a cleanup token only for the cleanup endpoint.
