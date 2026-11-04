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

            _busy = true;
            SetBusy(true);
            txtInput.Clear();
            AppendLine("You: " + text);
            AppendLine(_chat.ProviderName + " is thinking...");

            string failure = null;
            try
            {
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
                SetBusy(false);
                RefreshTranscript(); // transcript re-renders from the real history
                if (failure != null)
                {
                    AppendLine("[error] " + failure);
                    AppendLine("");
                }
                txtInput.Focus();
            }
        }

        private void btnClear_Click(object sender, EventArgs e)
        {
            _chat.Reset();
            RefreshTranscript();
            UpdateProviderStatus();
        }

        private void txtInput_KeyDown(object sender, KeyEventArgs e)
        {
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

        private void SetBusy(bool busy)
        {
            btnSend.Enabled = !busy;
            txtInput.Enabled = !busy;
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
            if (cboProvider.SelectedItem != null
                && (ProviderKind)cboProvider.SelectedItem == ProviderKind.OpenRouter)
            {
                cboProvider.SelectedItem = ProviderKind.Echo; // re-enters via SelectedIndexChanged
            }
        }
    }
}
