@echo off
setlocal enabledelayedexpansion
title Expense Tracker - Setup
echo.
echo  ============================================
echo   EXPENSE TRACKER - ONE-CLICK PROJECT SETUP
echo  ============================================
echo.

rem --- 1. Folder structure ---
if not exist "fixtures\pdfs" mkdir "fixtures\pdfs"
echo  [1/6] Folder structure created (fixtures\pdfs).

rem --- 2. Move statement PDFs into fixtures\pdfs ---
set MOVED=0
for %%F in (*.pdf) do (
    move /Y "%%F" "fixtures\pdfs\" >nul
    set /a MOVED+=1
)
echo  [2/6] Moved !MOVED! PDF file(s) into fixtures\pdfs.

rem --- 3. Create the deliberate duplicate trap file ---
if exist "fixtures\pdfs\RHB_4258608307183799_20260601.pdf" (
    copy /Y "fixtures\pdfs\RHB_4258608307183799_20260601.pdf" "fixtures\pdfs\RHB_4258608307183799_20260601_DUPLICATE.pdf" >nul
    echo  [3/6] Duplicate trap file created ^(RHB ..._20260601_DUPLICATE.pdf^).
) else (
    echo  [3/6] NOTE: RHB_4258608307183799_20260601.pdf not found - place it in
    echo         fixtures\pdfs and re-run this script to create the duplicate trap.
)

rem --- 4. Create .env template (only if it does not exist) ---
if not exist ".env" (
    (
    echo # Paste your real values after each = sign. Never share this file or its contents.
    echo ANTHROPIC_API_KEY=PASTE_YOUR_ANTHROPIC_KEY_HERE
    echo SUPABASE_URL=PASTE_YOUR_SUPABASE_PROJECT_URL_HERE
    echo SUPABASE_SERVICE_ROLE_KEY=PASTE_YOUR_SUPABASE_SERVICE_ROLE_KEY_HERE
    ) > ".env"
    echo  [4/6] .env template created.
) else (
    echo  [4/6] .env already exists - left untouched.
)

rem --- 5. .gitignore so secrets are never committed ---
if not exist ".gitignore" (
    (
    echo .env
    echo node_modules/
    echo fixtures/pdfs/
    ) > ".gitignore"
    echo  [5/6] .gitignore created ^(protects your keys and statements^).
) else (
    echo  [5/6] .gitignore already exists - left untouched.
)

rem --- 6. Sanity check for the three project files ---
set MISSING=0
for %%F in ("expense-tracker-spec.md" "claude-code-kickoff.md" "fixture-ground-truth.json") do (
    if not exist %%F (
        echo  [6/6] WARNING: %%F is MISSING from this folder.
        set MISSING=1
    )
)
if !MISSING! EQU 0 echo  [6/6] All three project files present.

echo.
echo  --------------------------------------------
echo   PDFs now in fixtures\pdfs:
dir /b "fixtures\pdfs"
echo  --------------------------------------------
echo.
echo  NEXT: Read START-HERE.txt for the 3 manual steps
echo  and the exact message to paste into Claude Code.
echo.
echo  Opening .env in Notepad - paste your keys there
echo  once you have them (see START-HERE.txt).
echo.
start notepad ".env"
if exist "START-HERE.txt" start notepad "START-HERE.txt"
pause
