## M1 hidden first flip + a visible non-ILR flip (backstop runs only when the parser finds none)
@P	if true; then gh issue edit 138 --add-label review ; fi; gh issue edit 99999 --add-label review
@P	sudo -u gh gh issue edit 138 --add-label review && gh issue edit 99999 --add-label review
@P	watch -n1 gh issue edit 138 --add-label review && gh issue edit 99999 --add-label review
@P	env -S 'gh issue edit 138 --add-label review' && gh issue edit 99999 --add-label review
## M2 realistic heredoc body holding a cd line
@P	gh issue comment 138 --body-file - <<'EOF'\nRepro:\ncd @T && ls\nEOF\ngh issue edit 138 --add-label review
@P	git commit -F - <<'EOF'\nfix\n\ncd @H\nEOF\ngh issue edit 138 --add-label review
## M3 realistic guarded cd
@P	[ -d @P/.claude/worktrees/issue-999 ] && cd @P/.claude/worktrees/issue-999; cd @T 2>/dev/null & gh issue edit 138 --add-label review
@P	test -d /nope && cd @T; gh issue edit 138 --add-label review
## M4 the AC6 real cases
@P	cd @H && gh issue edit 138 --remove-label dev/implement --add-label review
@P	gh -R joshgaskin/hatchery issue edit 138 --remove-label dev/implement --add-label review
@P	CATALINA_WITNESS_ALLOW=1 gh issue edit 138 --remove-label dev/implement --add-label review
