const TEMPLATES = Object.freeze({
  "dsl inspect": {
    id: "transformation-inspected",
    path: "reply-templates/transformation-inspected.md",
  },
  "dsl freeze:needs_decision": {
    id: "transformation-needs-decision",
    path: "reply-templates/transformation-needs-decision.md",
  },
  "dsl freeze": {
    id: "transformation-frozen",
    path: "reply-templates/transformation-frozen.md",
  },
  "transform execute": {
    id: "transformation-executed",
    path: "reply-templates/transformation-executed.md",
  },
  error: {
    id: "transformation-system-error",
    path: "reply-templates/transformation-system-error.md",
  },
});

export function replyTemplateFor(command, { status = null, ok = true } = {}) {
  if (!ok) return TEMPLATES.error;
  return TEMPLATES[`${command}:${status}`] ?? TEMPLATES[command];
}
