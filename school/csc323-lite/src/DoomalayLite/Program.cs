using System;
using System.Windows.Forms;

namespace DoomalayLite
{
    /// <summary>
    /// Application entry point (composition root).
    /// Builds the object graph and starts the Windows Forms message loop.
    /// </summary>
    internal static class Program
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new UI.frmChat());
        }
    }
}
