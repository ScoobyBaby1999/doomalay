using System;
using System.Windows.Forms;

namespace DCLbot
{
    // Where the program starts. It gets the window ready and starts
    // the Windows Forms message loop.
    internal static class Program
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // If something unexpected goes wrong while the window is
            // running, show a message and keep going instead of closing
            // the whole app.
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += (sender, e) =>
            {
                MessageBox.Show(
                    "Unexpected problem: " + e.Exception.Message + Environment.NewLine + Environment.NewLine
                    + "The app keeps running - you can send another message.",
                    "DCLbot",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
            };

            Application.Run(new UI.frmChat());
        }
    }
}
