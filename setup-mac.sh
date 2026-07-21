#!/bin/bash
# Expense Tracker - One-Click Project Setup (Mac)
# If double-clicking does not work: open Terminal, type  bash   (with a space),
# drag this file into the Terminal window, press Enter.

cd "$(dirname "$0")"
echo ""
echo " ============================================"
echo "  EXPENSE TRACKER - ONE-CLICK PROJECT SETUP"
echo " ============================================"
echo ""

# 1. Folder structure
mkdir -p fixtures/pdfs
echo " [1/6] Folder structure created (fixtures/pdfs)."

# 2. Move statement PDFs
MOVED=0
for f in *.pdf; do
  [ -e "$f" ] || continue
  mv -f "$f" fixtures/pdfs/ && MOVED=$((MOVED+1))
done
echo " [2/6] Moved $MOVED PDF file(s) into fixtures/pdfs."

# 3. Duplicate trap file
if [ -e "fixtures/pdfs/RHB_4258608307183799_20260601.pdf" ]; then
  cp -f "fixtures/pdfs/RHB_4258608307183799_20260601.pdf" \
        "fixtures/pdfs/RHB_4258608307183799_20260601_DUPLICATE.pdf"
  echo " [3/6] Duplicate trap file created (RHB ..._20260601_DUPLICATE.pdf)."
else
  echo " [3/6] NOTE: RHB_4258608307183799_20260601.pdf not found - place it in"
  echo "        fixtures/pdfs and re-run this script to create the duplicate trap."
fi

# 4. .env template
if [ ! -e ".env" ]; then
  cat > .env <<'EOF'
# Paste your real values after each = sign. Never share this file or its contents.
ANTHROPIC_API_KEY=PASTE_YOUR_ANTHROPIC_KEY_HERE
SUPABASE_URL=PASTE_YOUR_SUPABASE_PROJECT_URL_HERE
SUPABASE_SERVICE_ROLE_KEY=PASTE_YOUR_SUPABASE_SERVICE_ROLE_KEY_HERE
EOF
  echo " [4/6] .env template created."
else
  echo " [4/6] .env already exists - left untouched."
fi

# 5. .gitignore
if [ ! -e ".gitignore" ]; then
  printf ".env\nnode_modules/\nfixtures/pdfs/\n" > .gitignore
  echo " [5/6] .gitignore created (protects your keys and statements)."
else
  echo " [5/6] .gitignore already exists - left untouched."
fi

# 6. Project-file sanity check
MISSING=0
for f in "expense-tracker-spec.md" "claude-code-kickoff.md" "fixture-ground-truth.json"; do
  if [ ! -e "$f" ]; then
    echo " [6/6] WARNING: $f is MISSING from this folder."
    MISSING=1
  fi
done
[ $MISSING -eq 0 ] && echo " [6/6] All three project files present."

echo ""
echo " --------------------------------------------"
echo "  PDFs now in fixtures/pdfs:"
ls -1 fixtures/pdfs
echo " --------------------------------------------"
echo ""
echo " NEXT: Read START-HERE.txt for the 3 manual steps"
echo " and the exact message to paste into Claude Code."
echo ""
open -e .env 2>/dev/null
[ -e "START-HERE.txt" ] && open -e START-HERE.txt 2>/dev/null
read -p " Press Enter to close..."
