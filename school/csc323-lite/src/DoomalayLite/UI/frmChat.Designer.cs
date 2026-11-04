using System.Drawing;
using System.Windows.Forms;

namespace DoomalayLite.UI
{
    partial class frmChat
    {
        private System.ComponentModel.IContainer components = null;

        protected override void Dispose(bool disposing)
        {
            if (disposing && (components != null))
            {
                components.Dispose();
            }
            base.Dispose(disposing);
        }

        private void InitializeComponent()
        {
            this.components = new System.ComponentModel.Container();
            this.panelTop = new System.Windows.Forms.Panel();
            this.lblProvider = new System.Windows.Forms.Label();
            this.cboProvider = new System.Windows.Forms.ComboBox();
            this.btnClear = new System.Windows.Forms.Button();
            this.txtChat = new System.Windows.Forms.TextBox();
            this.panelBottom = new System.Windows.Forms.Panel();
            this.btnSend = new System.Windows.Forms.Button();
            this.txtInput = new System.Windows.Forms.TextBox();
            this.statusStrip = new System.Windows.Forms.StatusStrip();
            this.status = new System.Windows.Forms.ToolStripStatusLabel();
            this.panelTop.SuspendLayout();
            this.panelBottom.SuspendLayout();
            this.statusStrip.SuspendLayout();
            this.SuspendLayout();
            //
            // panelTop
            //
            this.panelTop.Controls.Add(this.lblProvider);
            this.panelTop.Controls.Add(this.cboProvider);
            this.panelTop.Controls.Add(this.btnClear);
            this.panelTop.Dock = System.Windows.Forms.DockStyle.Top;
            this.panelTop.Location = new System.Drawing.Point(0, 0);
            this.panelTop.Name = "panelTop";
            this.panelTop.Padding = new System.Windows.Forms.Padding(10, 8, 10, 8);
            this.panelTop.Size = new System.Drawing.Size(684, 48);
            //
            // lblProvider
            //
            this.lblProvider.AutoSize = true;
            this.lblProvider.Location = new System.Drawing.Point(13, 15);
            this.lblProvider.Name = "lblProvider";
            this.lblProvider.Text = "Provider:";
            //
            // cboProvider
            //
            this.cboProvider.DropDownStyle = System.Windows.Forms.ComboBoxStyle.DropDownList;
            this.cboProvider.FormattingEnabled = true;
            this.cboProvider.Location = new System.Drawing.Point(78, 11);
            this.cboProvider.Name = "cboProvider";
            this.cboProvider.Size = new System.Drawing.Size(180, 23);
            this.cboProvider.SelectedIndexChanged += new System.EventHandler(this.cboProvider_SelectedIndexChanged);
            //
            // btnClear
            //
            this.btnClear.Location = new System.Drawing.Point(574, 9);
            this.btnClear.Name = "btnClear";
            this.btnClear.Size = new System.Drawing.Size(96, 26);
            this.btnClear.Text = "New chat";
            this.btnClear.Click += new System.EventHandler(this.btnClear_Click);
            //
            // txtChat
            //
            this.txtChat.BackColor = System.Drawing.Color.White;
            this.txtChat.Dock = System.Windows.Forms.DockStyle.Fill;
            this.txtChat.Font = new Font("Consolas", 9.75F);
            this.txtChat.Location = new System.Drawing.Point(0, 48);
            this.txtChat.Multiline = true;
            this.txtChat.Name = "txtChat";
            this.txtChat.ReadOnly = true;
            this.txtChat.ScrollBars = System.Windows.Forms.ScrollBars.Vertical;
            this.txtChat.Size = new System.Drawing.Size(684, 296);
            this.txtChat.TabIndex = 1;
            //
            // panelBottom
            //
            this.panelBottom.Controls.Add(this.btnSend);
            this.panelBottom.Controls.Add(this.txtInput);
            this.panelBottom.Dock = System.Windows.Forms.DockStyle.Bottom;
            this.panelBottom.Location = new System.Drawing.Point(0, 320);
            this.panelBottom.Name = "panelBottom";
            this.panelBottom.Padding = new System.Windows.Forms.Padding(10, 8, 10, 8);
            this.panelBottom.Size = new System.Drawing.Size(684, 72);
            //
            // btnSend
            //
            this.btnSend.Dock = System.Windows.Forms.DockStyle.Right;
            this.btnSend.Font = new Font("Segoe UI", 9.75F, FontStyle.Bold);
            this.btnSend.Location = new System.Drawing.Point(574, 8);
            this.btnSend.Name = "btnSend";
            this.btnSend.Size = new System.Drawing.Size(100, 56);
            this.btnSend.Text = "Send";
            this.btnSend.Click += new System.EventHandler(this.btnSend_Click);
            //
            // txtInput
            //
            this.txtInput.Dock = System.Windows.Forms.DockStyle.Fill;
            this.txtInput.Font = new Font("Segoe UI", 10F);
            this.txtInput.Location = new System.Drawing.Point(10, 8);
            this.txtInput.Multiline = true;
            this.txtInput.Name = "txtInput";
            this.txtInput.Size = new System.Drawing.Size(556, 56);
            this.txtInput.TabIndex = 0;
            this.txtInput.KeyDown += new System.Windows.Forms.KeyEventHandler(this.txtInput_KeyDown);
            //
            // statusStrip
            //
            this.statusStrip.Items.AddRange(new System.Windows.Forms.ToolStripItem[] { this.status });
            this.statusStrip.Location = new System.Drawing.Point(0, 392);
            this.statusStrip.Name = "statusStrip";
            this.statusStrip.Size = new System.Drawing.Size(684, 22);
            //
            // status
            //
            this.status.Name = "status";
            this.status.Text = "Starting...";
            //
            // frmChat
            //
            this.AcceptButton = this.btnSend;
            this.AutoScaleDimensions = new SizeF(7F, 15F);
            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
            this.ClientSize = new Size(684, 414);
            this.Controls.Add(this.txtChat);
            this.Controls.Add(this.panelTop);
            this.Controls.Add(this.statusStrip);
            this.Controls.Add(this.panelBottom);
            this.MinimumSize = new Size(480, 360);
            this.Name = "frmChat";
            this.StartPosition = FormStartPosition.CenterScreen;
            this.Text = "Doomalay Lite";
            this.panelTop.ResumeLayout(false);
            this.panelTop.PerformLayout();
            this.panelBottom.ResumeLayout(false);
            this.panelBottom.PerformLayout();
            this.statusStrip.ResumeLayout(false);
            this.statusStrip.PerformLayout();
            this.ResumeLayout(false);
            this.PerformLayout();
        }

        private System.Windows.Forms.Panel panelTop;
        private System.Windows.Forms.Label lblProvider;
        private System.Windows.Forms.ComboBox cboProvider;
        private System.Windows.Forms.Button btnClear;
        private System.Windows.Forms.TextBox txtChat;
        private System.Windows.Forms.Panel panelBottom;
        private System.Windows.Forms.Button btnSend;
        private System.Windows.Forms.TextBox txtInput;
        private System.Windows.Forms.StatusStrip statusStrip;
        private System.Windows.Forms.ToolStripStatusLabel status;
    }
}
