#!/bin/bash

FILES=(
"packages/shared/src/tools.ts"
"packages/shared/src/timeline.ts"
"packages/shared/src/types.ts"
"packages/shared/src/effects.ts"
"packages/shared/src/catalog.ts"
"apps/web/src/tools/capabilities.ts"
"apps/web/src/tools/tool-runner.ts"
"apps/web/src/tools/index.ts"
"packages/shared/src/tool-adapters.ts"
"apps/web/src/pages/EditorPage.tsx"
"apps/api/src/services/aiPlanner.service.ts"
)

STATE_FILE=".review_index"

if [ ! -f "$STATE_FILE" ]; then
    echo 0 > "$STATE_FILE"
fi

INDEX=$(cat "$STATE_FILE")

if [ "$INDEX" -ge "${#FILES[@]}" ]; then
    echo "All files completed."
    exit 0
fi

FILE="${FILES[$INDEX]}"

echo ""
echo "========== $FILE =========="
echo ""

cat "$FILE"

echo $((INDEX + 1)) > "$STATE_FILE"

echo ""
echo "Next file index saved."
echo "Run ./next-file.sh again."