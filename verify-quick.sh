#!/bin/bash
echo "🔍 Quick verification..."
node verify-migration-003.js 2>&1 | grep -E "✅|❌|🎉|Migration 003"
