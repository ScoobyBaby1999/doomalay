using System;
using System.Windows.Forms;

namespace DoomalayLite.UI
{
    /// <summary>
    /// Main chat window. Owns no business logic: it only paints state and
    /// delegates every decision to the ChatService (Single Responsibility).
    /// v0.1.0: scaffold placeholder - the real chat UI lands in v0.6.0.
    /// </summary>
    public partial class frmChat : Form
    {
        public frmChat()
        {
            InitializeComponent();
        }
    }
}
