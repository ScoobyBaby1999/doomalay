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
            this.lblScaffold = new System.Windows.Forms.Label();
            this.SuspendLayout();
            //
            // lblScaffold
            //
            this.lblScaffold.Dock = System.Windows.Forms.DockStyle.Fill;
            this.lblScaffold.Font = new Font("Segoe UI", 11F);
            this.lblScaffold.ForeColor = Color.DimGray;
            this.lblScaffold.Name = "lblScaffold";
            this.lblScaffold.Text = "Doomalay Lite - scaffold v0.1.0\r\n(the chat UI arrives in v0.6.0)";
            this.lblScaffold.TextAlign = ContentAlignment.MiddleCenter;
            //
            // frmChat
            //
            this.AutoScaleDimensions = new SizeF(7F, 15F);
            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
            this.ClientSize = new Size(640, 420);
            this.Controls.Add(this.lblScaffold);
            this.FormBorderStyle = System.Windows.Forms.FormBorderStyle.FixedSingle;
            this.MaximizeBox = false;
            this.Name = "frmChat";
            this.StartPosition = FormStartPosition.CenterScreen;
            this.Text = "Doomalay Lite";
            this.ResumeLayout(false);
        }

        private System.Windows.Forms.Label lblScaffold;
    }
}
