' Hidden-window launcher for the scheduled task (no console flash in Alex's session).
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
CreateObject("Wscript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\bin\herdr-voice-engine.ps1""", 0, False
