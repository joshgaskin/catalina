# The witness's first hostile set for #27 (adv.txt), paths as @P plus2, @H hatchery, @T a dir outside any repo.
## A. cd forms (from plus2)
@P	cd '@H' && gh issue edit 138 --add-label review
@P	cd "$HOME/Documents/dev/projects/hatchery" && gh issue edit 138 --add-label review
@P	cd ~/Documents/dev/projects/hatchery/.claude; gh issue edit 138 --add-label review
@P	cd @H\ngh issue edit 138 --add-label review
@P	{ cd ../hatchery && gh issue edit 138 --add-label review; }
@P	pushd ../hatchery && gh issue edit 138 --add-label review && popd
@P	git commit -m "cd ../hatchery && x" && gh issue edit 138 --add-label review
## B. subshell scope: gh runs in plus2 after the subshell closes (expect plus2 reasons)
@P	(cd ../hatchery && git pull -q) && gh issue edit 138 --add-label review
@P	X=$(cd ../hatchery && pwd) && gh issue edit 138 --add-label review
## C. unexpanded variables / failed cd (expect gated, or at least a notice)
@P	WT=@H; cd $WT && gh issue edit 138 --add-label review
@P	WT=@P; cd "$WT" && gh issue edit 138 --add-label review
@P	cd $(git rev-parse --show-toplevel) && gh issue edit 138 --add-label review
@P	cd /no/such/dir; gh issue edit 138 --add-label review
## D. -R / URL variants
@P	gh issue edit -R joshgaskin/hatchery 138 --add-label review
@P	gh issue edit 138 --add-label review -R joshgaskin/hatchery
@P	gh -Rjoshgaskin/hatchery issue edit 138 --add-label review
@P	gh issue edit 138 --add-label review --repo JoshGaskin/Hatchery
@P	cd ../catalina && gh issue edit https://github.com/joshgaskin/hatchery/issues/138 --add-label review
@P/.claude/worktrees/issue-2228	gh -R joshgaskin/hatchery issue edit 138 --add-label review
@H	gh issue edit https://github.com/joshgaskin/plus2/issues/138 https://github.com/joshgaskin/hatchery/issues/17 --add-label review
## E. GH_REPO env (gh honours it)
@P	GH_REPO=joshgaskin/hatchery gh issue edit 138 --add-label review
## F. shell wrappers
@P	bash -c 'cd ../hatchery && gh issue edit 138 --add-label review'
@P	zsh -lc "gh issue edit 138 --add-label review"
@P	cd ../hatchery && bash -c 'gh issue edit 138 --add-label review'
@P	bash -c 'cd ../hatchery' && gh issue edit 138 --add-label review
@P	CATALINA_WITNESS_ALLOW=1 bash -c 'gh issue edit 138 --add-label review'
@P	/bin/bash -x -c 'gh issue edit 138 --add-label review'
## G. other wrappers the old regex caught
@P	/opt/homebrew/bin/gh issue edit 138 --add-label review
@P	timeout 60 gh issue edit 138 --add-label review
@P	command gh issue edit 138 --add-label review
@P	echo 138 | xargs -I{} gh issue edit {} --add-label review
@P	env -u FOO gh issue edit 138 --add-label review
## H. bypass placement
@P	gh issue view 138 | CATALINA_WITNESS_ALLOW=1 gh issue edit 138 --add-label review
@P	CATALINA_WITNESS_ALLOW=1 gh issue view 138 | gh issue edit 138 --add-label review
@P	CATALINA_WITNESS_ALLOW=1 && gh issue edit 138 --add-label review
@P	export CATALINA_WITNESS_ALLOW=1; cd ../hatchery && gh issue edit 138 --add-label review
@P	export CATALINA_WITNESS_ALLOW=1 && export CATALINA_WITNESS_ALLOW=0 && gh issue edit 138 --add-label review
@P	CATALINA_WITNESS_ALLOW="1" gh issue edit 138 --add-label review
@P	echo "CATALINA_WITNESS_ALLOW=1 gh issue edit 138 --add-label review"
@P	gh issue edit 138 --body 'CATALINA_WITNESS_ALLOW=1' --add-label review
@P	cd ../hatchery && CATALINA_WITNESS_ALLOW=1 gh issue edit 138 --add-label review && gh issue edit 17 --add-label review
## I. numbers and labels
@H	gh issue edit 138 17 --add-label review
@P	gh issue edit --add-label review 138
@P	gh issue edit #138 --add-label "dev/x, review" --body "see #200 and 300"
@P	gh issue edit 138 --add-label reviewer
@P	gh issue edit --add-label review
@P	gh issue edit 138 --add-label review --body "unterminated
## J. git -C
@P	git -C ../hatchery log -1 && gh issue edit 138 --add-label review
@P	cd ../hatchery && git -C . status && gh issue edit 138 --add-label review
## K. non-repo cwd
@T	gh issue edit 138 --add-label review
@T	gh -R joshgaskin/hatchery issue edit 138 --add-label review
