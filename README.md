# Break Reminder

An [LLMHub](https://github.com/huangdihd/LLMHub) plugin for people who code
with a model all day and would like something to tell them when to stop.

Mark the API keys your coding tools use and set a daily limit. Once those keys
have used it up, the gateway stops calling the model and answers with a
reminder to take a break instead. In Cursor, Claude Code or any other client it
looks like an ordinary reply.

- **Pick the keys**: on the API Keys page, edit a key and switch on "Counts
  toward the daily coding limit". Other keys are never affected.
- **Set the limit** on the plugin's Configure page: tokens per day, requests
  per day, or both. With both, whichever is reached first applies. All marked
  keys share one total.
- **Write your own reminders**, one per line. One is picked at random each
  time. `{tokens}` and `{requests}` are replaced with today's usage, and
  `{reset}` with the time the count starts over.
- **The day starts at 4 a.m.** by default, server time, so a late night counts
  toward the day before. Change the hour on the Configure page.

The home page shows how much of today's limit is used.

There is no "five more minutes" button. To keep going, raise the limit or
switch the key off, on purpose.

## Good to know

- A request already in progress is never cut off; the check happens when a
  request starts, so the total can end slightly above the limit.
- Reminders are not counted, and they do not call any upstream.
- Failed requests count as a request. Embedding requests are counted but never
  answered with a reminder.
- The count survives a restart. It is saved about once a second, so a crash can
  lose the last moment of usage.

## Install

In LLMHub, open **Plugins → Install from GitHub**, enter
`huangdihd/llmhub-plugin-break-reminder`, then enable the plugin.

It needs an LLMHub release that provides plugin API 1.5 or later.

## Development

```sh
npm test
```

The tests run the plugin against a stand-in for the plugin API, with an
injected clock. There are no dependencies and no build step.
