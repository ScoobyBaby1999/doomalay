using System;
using System.Threading.Tasks;
using System.Windows.Forms;
using DoomalayLite.Core;
using DoomalayLite.Providers;
using DoomalayLite.Services;

namespace DoomalayLite.UI
{
    /// <summary>
    /// Main chat window. Owns ZERO business logic (Single Responsibility):
    /// it paints state, captures input, and delegates every decision to the
    /// ChatService singleton. The provider combo box is the live Liskov demo:
    /// OpenRouter and the offline Echo twin are interchangeable at runtime.
    /// </summary>
    public partial class frmChat : Form
    {
        private ChatService _chat;
        private bool _busy;
        private bool _switchingProvider;

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
                // state can never get stuck again.
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
            Text = busy ? "Doomalay Lite - thinking..." : "Doomalay Lite";
        }

        private void UpdateProviderStatus()
        {
            if (_chat.ProviderReady)
            {
                status.Text = string.Format("Ready - {0}  |  model: {1}", _chat.ProviderName, _chat.ModelName);
                return;
            }

            status.Text = "No API key. Set OPENROUTER_API_KEY (env var), or use the offline Echo provider.";

            // Graceful degradation: without a key, land on the offline twin.
            // The guard flag keeps the selection change from re-entering this
            // method through cboProvider_SelectedIndexChanged.
            if (!_switchingProvider
                && cboProvider.SelectedItem != null
                && (ProviderKind)cboProvider.SelectedItem == ProviderKind.OpenRouter)
            {
                _switchingProvider = true;
                try
                {
                    cboProvider.SelectedItem = ProviderKind.Echo; // re-enters via SelectedIndexChanged
                }
                finally
                {
                    _switchingProvider = false;
                }
            }
        }
    }
}
