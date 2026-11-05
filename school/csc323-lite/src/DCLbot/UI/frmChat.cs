using System;
using System.Threading.Tasks;
using System.Windows.Forms;
using DCLbot.Core;
using DCLbot.Providers;
using DCLbot.Services;

namespace DCLbot.UI
{
    // The main window. It does not contain any real logic - it just
    // shows the chat, takes the input, and lets ChatService do the
    // actual work.
    public partial class frmChat : Form
    {
        private ChatService _chat;
        private bool _busy;

        public frmChat()
        {
            InitializeComponent();
            _chat = ChatService.GetInstance();

            // Put the two providers in the combo box.
            foreach (ProviderKind kind in Enum.GetValues(typeof(ProviderKind)))
            {
                cboProvider.Items.Add(kind);
            }
            cboProvider.SelectedIndex = 0;

            RefreshTranscript();
            UpdateProviderStatus();
        }

        // ------------------------------------------------------------------
        // button and box events
        // ------------------------------------------------------------------

        // Runs when the user picks a provider. Remember the choice and
        // update the status bar - whatever the user picks stays picked.
        private void cboProvider_SelectedIndexChanged(object sender, EventArgs e)
        {
            if (cboProvider.SelectedItem == null)
            {
                return;
            }
            ProviderKind kind = (ProviderKind)cboProvider.SelectedItem;
            _chat.SwitchProvider(kind);
            UpdateProviderStatus();
        }

        private async void btnSend_Click(object sender, EventArgs e)
        {
            string text = txtInput.Text.Trim();
            if (text.Length == 0 || _busy)
            {
                return; // nothing typed, or still waiting for an answer
            }

            SetBusy(true);
            string failure = null;
            try
            {
                txtInput.Clear();
                AppendLine("You: " + text);
                AppendLine(_chat.ProviderName + " is thinking...");

                // Ask on a background thread so the window does not freeze.
                ChatReply reply = await Task.Run(() => _chat.SendUserMessage(text));
                AppendLine("Bot: " + reply.Content);
                AppendLine(string.Format("     ({0} - {1}s)", reply.ModelUsed, reply.ElapsedSeconds));
            }
            catch (ProviderException ex)
            {
                failure = ex.Message; // expected problems, already have a good message
            }
            catch (Exception ex)
            {
                failure = "Unexpected problem: " + ex.Message;
            }
            finally
            {
                // Always unlock everything again, even if something went
                // wrong above, so the next message can be sent.
                SetBusy(false);
                RefreshTranscript(); // redraw the chat from the saved history
                if (failure != null)
                {
                    AppendLine("[error] " + failure);
                    AppendLine("");
                }
                ActiveControl = txtInput; // put the keyboard focus back
            }
        }

        // New chat: forget the old conversation and start over.
        private void btnClear_Click(object sender, EventArgs e)
        {
            _chat.Reset();
            RefreshTranscript();
            UpdateProviderStatus();
            ActiveControl = txtInput;
        }

        // Pressing Enter sends the message. Shift+Enter makes a new line.
        private void txtInput_KeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter && !e.Shift)
            {
                e.SuppressKeyPress = true; // no beep, no empty line
                btnSend.PerformClick();
            }
        }

        // ------------------------------------------------------------------
        // drawing the window contents
        // ------------------------------------------------------------------

        // Redraw the big chat box from the saved history and scroll down.
        private void RefreshTranscript()
        {
            txtChat.Text = _chat.History.Render();
            txtChat.SelectionStart = txtChat.TextLength;
            txtChat.ScrollToCaret();
        }

        // Add one line. Safe to call from another thread too.
        private void AppendLine(string text)
        {
            if (txtChat.InvokeRequired)
            {
                txtChat.BeginInvoke((Action)(() => AppendLine(text)));
                return;
            }
            txtChat.AppendText(text + Environment.NewLine);
        }

        // Lock or unlock the sending while waiting for an answer. The
        // flag and the buttons are always changed together in this one
        // place, so they can never disagree. The input box is made
        // read-only instead of disabled so it keeps the keyboard focus.
        private void SetBusy(bool busy)
        {
            _busy = busy;
            btnSend.Enabled = !busy;
            txtInput.ReadOnly = busy;
            UseWaitCursor = busy;
            Text = busy ? "DCLbot - thinking..." : "DCLbot";
        }

        // Show whether the current provider is ready to go.
        private void UpdateProviderStatus()
        {
            if (_chat.ProviderReady)
            {
                status.Text = string.Format("Ready - {0}  |  model: {1}", _chat.ProviderName, _chat.ModelName);
                return;
            }

            status.Text = _chat.ProviderName
                + " has no API key. Set OPENROUTER_API_KEY (env var), or pick Echo for offline mode.";
        }
    }
}
