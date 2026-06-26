// AI help assistant - a chat panel reachable from the header button on
// every screen. Answers questions about how the app works and about the
// logged-in employee's own data (their hours, PTO, approval status).
// The backend (netlify/functions/assistant.js) injects that employee's
// own real data into the system prompt server-side - the frontend never
// sees or sends anyone else's information, and never talks to the
// Anthropic API directly (the API key stays server-side).

let assistantMessages = []; // [{role: 'user'|'assistant', content: string}]
let assistantOverlay = null;

function openAssistantPanel() {
  if (assistantOverlay) return; // already open

  assistantOverlay = document.createElement('div');
  assistantOverlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:flex-end;justify-content:center;z-index:200;';
  assistantOverlay.innerHTML = `
    <div style="background:#fff;border-radius:16px 16px 0 0;width:100%;max-width:480px;height:80vh;display:flex;flex-direction:column;">
      <div style="display:flex; align-items:center; justify-content:space-between; padding:16px 18px; border-bottom:1px solid var(--line);">
        <div>
          <div style="font-weight:700; font-size:16px;">Help</div>
          <div style="font-size:12px; color:var(--ink-soft);">Ask about your hours, leave, or how the app works</div>
        </div>
        <button id="assistant-close-btn" style="background:none; border:none; font-size:22px; line-height:1; cursor:pointer; color:var(--ink-soft); padding:4px 8px;">&times;</button>
      </div>
      <div id="assistant-messages" style="flex:1; overflow-y:auto; padding:16px 18px; display:flex; flex-direction:column; gap:10px;"></div>
      <div style="padding:12px 16px; border-top:1px solid var(--line); display:flex; gap:8px;">
        <input id="assistant-input" type="text" placeholder="Type your question..." style="flex:1; padding:11px 14px; border-radius:20px; border:1.5px solid var(--line); font-size:15px;" />
        <button id="assistant-send-btn" class="btn btn-primary" style="width:auto; padding:11px 18px; border-radius:20px;">Send</button>
      </div>
    </div>
  `;
  document.body.appendChild(assistantOverlay);

  document.getElementById('assistant-close-btn').addEventListener('click', closeAssistantPanel);
  document.getElementById('assistant-send-btn').addEventListener('click', sendAssistantMessage);
  document.getElementById('assistant-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendAssistantMessage();
  });

  renderAssistantMessages();

  if (assistantMessages.length === 0) {
    renderAssistantBubble('assistant', "Hi! Ask me anything about how the app works, or about your own hours, leave, or approval status.");
  }

  document.getElementById('assistant-input').focus();
}

function closeAssistantPanel() {
  if (assistantOverlay) {
    document.body.removeChild(assistantOverlay);
    assistantOverlay = null;
  }
}

function renderAssistantMessages() {
  const container = document.getElementById('assistant-messages');
  if (!container) return;
  container.innerHTML = '';
  for (const m of assistantMessages) {
    appendAssistantBubble(container, m.role, m.content);
  }
  container.scrollTop = container.scrollHeight;
}

function renderAssistantBubble(role, content) {
  const container = document.getElementById('assistant-messages');
  if (!container) return;
  appendAssistantBubble(container, role, content);
  container.scrollTop = container.scrollHeight;
}

function appendAssistantBubble(container, role, content) {
  const bubble = document.createElement('div');
  const isUser = role === 'user';
  bubble.style.cssText = `
    align-self: ${isUser ? 'flex-end' : 'flex-start'};
    max-width: 80%;
    padding: 10px 14px;
    border-radius: 14px;
    font-size: 14px;
    line-height: 1.4;
    white-space: pre-wrap;
    background: ${isUser ? 'var(--ink)' : 'var(--paper-dim)'};
    color: ${isUser ? 'var(--paper)' : 'var(--ink)'};
  `;
  bubble.textContent = content;
  container.appendChild(bubble);
}

async function sendAssistantMessage() {
  const input = document.getElementById('assistant-input');
  const sendBtn = document.getElementById('assistant-send-btn');
  const text = input.value.trim();
  if (!text) return;

  assistantMessages.push({ role: 'user', content: text });
  renderAssistantBubble('user', text);
  input.value = '';
  input.disabled = true;
  sendBtn.disabled = true;

  const container = document.getElementById('assistant-messages');
  const thinkingBubble = document.createElement('div');
  thinkingBubble.id = 'assistant-thinking';
  thinkingBubble.style.cssText = 'align-self:flex-start; padding:10px 14px; border-radius:14px; font-size:14px; background:var(--paper-dim); color:var(--ink-soft);';
  thinkingBubble.textContent = 'Thinking...';
  container.appendChild(thinkingBubble);
  container.scrollTop = container.scrollHeight;

  try {
    const data = await api('/assistant', {
      method: 'POST',
      body: JSON.stringify({
        companyId: state.activeCompanyId,
        messages: assistantMessages,
      }),
    });

    document.getElementById('assistant-thinking')?.remove();
    assistantMessages.push({ role: 'assistant', content: data.reply });
    renderAssistantBubble('assistant', data.reply);
  } catch (err) {
    document.getElementById('assistant-thinking')?.remove();
    renderAssistantBubble('assistant', `Sorry, something went wrong: ${err.message}`);
  } finally {
    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
  }
}
