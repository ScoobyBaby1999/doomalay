using System;
using System.Threading.Tasks;
using System.Windows.Forms;
using DCLbot.Core;
using DCLbot.Providers;
using DCLbot.Services;

namespace DCLbot.UI
{
    /// <summary>
    /// Main chat window. Owns ZERO business logic (Single Responsibility):
    /// it paints state, captures input, and delegates every decision to the
    /// ChatService singleton. The provider combo box is the live Liskov demo:
    /// OpenRouter and the offline Echo twin are interchangeable at runtime.
    ///
    /// v0.7.1 hardening kept: ONE place (SetBusy) owns the busy flag together
    /// with the visuals - the flag can never disagree with the UI again (the
    /// original "only one message per app run" bug); the whole send turn runs
    /// inside try/finally; the input uses ReadOnly (never Enabled=false) so
    /// keyboard focus survives while thinking; Enter is routed through the
    /// input box KeyDown (AcceptsReturn = true).
    ///
    /// v0.8.0 additions: the provider combo is NEVER hijacked - what the user
    /// picks stays picked; readiness is explained honestly in the status bar,
    /// and a not-ready provider that receives a message answers with a clean,
    /// actionable [error] line instead of bouncing the selection back.
    /// </summary>
    public partial class frmChat : Form
    {
        private ChatService _chat;
        private bool _busy;

        public frmChat()
        {
            InitializeComponent();
            _chat = ChatService.GetInstance();

            // Fill the provider combo from the enum itself (never a hand list).
            foreach (ProviderKind kind in Enum.GetValues(typeof(ProviderKind)))
            {
                cboProvider.Items.Add(kind);
            }
            cboProvider.SelectedIndex = 0;

            RefreshTranscript();
            UpdateProviderStatus();
        }

        // ------------------------------------------------------------------
        // events
        // ------------------------------------------------------------------

        private void cboProvider_SelectedIndexChanged(object sender, EventArgs e)
        {
            if (cboProvider.SelectedItem == null)
            {
                return;
            }
            ProviderKind kind = (ProviderKind)cboProvider.SelectedItem; // downcast: Ch.3
            _chat.SwitchProvider(kind);

            // v0.8.0: the user's selection is FINAL. The old build bounced the
            // combo back to Echo whenever OpenRouter reported "not ready",
            // which made OpenRouter impossible to select. Readiness now only
            // paints the status bar.
            UpdateProviderStatus();
        }

        private async void btnSend_Click(object sender, EventArgs e)
        {
            string text = txtInput.Text.Trim();
            if (text.Length == 0 || _busy)
            {
                return; // guards: no empty sends, no double-fire while thinking
            }

            SetBusy(true);
            string failure = null;
            try
            {
                txtInput.Clear();
                AppendLine("You: " + text);
                AppendLine(_chat.ProviderName + " is thinking...");

                // The network call runs off the UI thread; the form stays alive.
                ChatReply reply = await Task.Run(() => _chat.SendUserMessage(text));
                AppendLine("Bot: " + reply.Content);
                AppendLine(string.Format("     ({0} - {1}s)", reply.ModelUsed, reply.ElapsedSeconds));
            }
            catch (ProviderException ex)
            {
                failure = ex.Message; // clean, human-readable domain errors
            }
            catch (Exception ex)
            {
                failure = "Unexpected problem: " + ex.Message;
            }
            finally
            {
                // SetBusy(false) clears _busy too, so the very next message can
                // be sent. The whole turn lives inside try/finally: the busy
                // state can never get stuck again (the v0.7.1 root-cause fix
                // for "only one message per app run").
                SetBusy(false);
                RefreshTranscript(); // transcript re-renders from the real history
                if (failure != null)
                {
                    AppendLine("[error] " + failure);
                    AppendLine("");
                }
                ActiveControl = txtInput; // keyboard focus back in the input box
            }
        }

        private void btnClear_Click(object sender, EventArgs e)
        {
            _chat.Reset();
            RefreshTranscript();
            UpdateProviderStatus();
            ActiveControl = txtInput;
        }

        private void txtInput_KeyDown(object sender, KeyEventArgs e)
        {
            // AcceptsReturn = true (Designer) makes plain Enter an input key of
            // the multiline box, so this handler is the live Enter path while
            // typing; the form's AcceptButton covers Enter when another control
            // has the focus. Both roads end in btnSend_Click exactly once.
            if (e.KeyCode == Keys.Enter && !e.Shift)
            {
                e.SuppressKeyPress = true; // no ding, no newline
                btnSend.PerformClick();
            }
        }

        // ------------------------------------------------------------------
        // painting helpers
        // ------------------------------------------------------------------

        private void RefreshTranscript()
        {
            txtChat.Text = _chat.History.Render();
            txtChat.SelectionStart = txtChat.TextLength;
            txtChat.ScrollToCaret();
        }

        private void AppendLine(string text)
        {
            if (txtChat.InvokeRequired)
            {
                txtChat.BeginInvoke((Action)(() => AppendLine(text)));
                return;
            }
            txtChat.AppendText(text + Environment.NewLine);
        }

        /// <summary>
        /// ONE place owns the busy state: the guard flag and the visuals are
        /// always changed together, so they can never disagree. The input box
        /// switches to ReadOnly (not Enabled = false) so it never loses
        /// keyboard focus while a reply is being generated.
        /// </summary>
        private void SetBusy(bool busy)
        {
            _busy = busy;
            btnSend.Enabled = !busy;
            txtInput.ReadOnly = busy;
            UseWaitCursor = busy;
            Text = busy ? "DCLbot - thinking..." : "DCLbot";
        }

        private void UpdateProviderStatus()
        {
            if (_chat.ProviderReady)
            {
                status.Text = string.Format("Ready - {0}  |  model: {1}", _chat.ProviderName, _chat.ModelName);
                return;
            }

            // Inform, never hijack (v0.8.0): the combo stays exactly where the
            // user put it; the next send against a not-ready provider returns
            // this same guidance as a clean [error] line.
            status.Text = _chat.ProviderName
                + " has no API key. Set OPENROUTER_API_KEY (env var), or pick Echo for offline mode.";
        }
    }
}
