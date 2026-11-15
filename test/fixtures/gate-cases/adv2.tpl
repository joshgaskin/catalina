## N1 cd -, pushd/popd, bare cd, HOME
@P	cd @T && cd - && gh issue edit 138 --add-label review
@P	cd - && gh issue edit 138 --add-label review
@P	pushd @T && popd && gh issue edit 138 --add-label review
@P	cd @T && cd @P && popd; gh issue edit 138 --add-label review
@P	pushd @H >/dev/null; pushd @T >/dev/null; popd >/dev/null; gh issue edit 138 --add-label review
@P	cd; gh issue edit 138 --add-label review
@P	cd ~ && gh issue edit 138 --add-label review
@P	HOME=@P; cd; gh issue edit 138 --add-label review
@P	HOME=@T cd ~ && gh issue edit 138 --add-label review
@P	pushd && gh issue edit 138 --add-label review
## N2 conditional / failing cd
@P	false && cd @T; gh issue edit 138 --add-label review
@P	cd @H || cd @T; gh issue edit 138 --add-label review
@P	[ -d /nope ] && cd @T; gh issue edit 138 --add-label review
@P	if false; then cd @T; fi; gh issue edit 138 --add-label review
## N3 pipelines/background: cd in a pipeline stage or & runs in a subshell
@P	cd @T | cat; gh issue edit 138 --add-label review
@P	cd @T & gh issue edit 138 --add-label review
## N4 comments, heredocs, here-strings, strings
@P	true # ; cd @T\ngh issue edit 138 --add-label review
@P	# cd @T\ngh issue edit 138 --add-label review
@P	cat > /dev/null <<'X'\ncd @T\nX\ngh issue edit 138 --add-label review
@P	cat <<'X'\nnotes (draft\nX\ngh issue edit 138 --add-label review
@P	cat <<< "cd @T" && gh issue edit 138 --add-label review
@P	echo "cd @T && gh issue edit 138 --add-label review"
@P	# gh issue edit 138 --add-label review
@P	echo 'gh issue edit 138 --add-label review' > /dev/null
## N5 functions, eval, alias
@P	f(){ cd @T; }; gh issue edit 138 --add-label review
@P	f(){ gh issue edit 138 --add-label review; }; f
@P	f() { cd @H; }; f; gh issue edit 138 --add-label review
@P	eval "cd @T"; gh issue edit 138 --add-label review
@P	eval "$(echo gh issue edit 138 --add-label review)"
@P	alias g=gh; g issue edit 138 --add-label review
## N6 nested shells / quotes
@P	sh -c "cd @H; gh issue edit 138 --add-label review"
@P	bash -c "bash -c 'cd @T; gh issue edit 138 --add-label review'"
@P	bash -c 'cd @T' ; sh -c "gh issue edit 138 --add-label \"review\""
@P	bash -c "cd '@H' && gh issue edit 138 --add-label review"
## N7 compound keywords hiding the first flip, a visible non-ILR flip after (main checks the first number)
@P	if true; then gh issue edit 138 --add-label review; fi; gh issue edit 99999 --add-label review
@P	for i in 1; do gh issue edit 138 --add-label review; done && gh issue edit 99999 --add-label review
@P	! gh issue edit 138 --add-label review; gh issue edit 99999 --add-label review
@P	watch -n1 gh issue edit 138 --add-label review; gh issue edit 99999 --add-label review
@P	env -S 'gh issue edit 138 --add-label review'; gh issue edit 99999 --add-label review
@P	sudo -u gh gh issue edit 138 --add-label review; gh issue edit 99999 --add-label review
@P	if true; then gh issue edit 138 --add-label review; fi
@P	cd @T && if true; then gh issue edit 138 --add-label review; fi
## N8 wrappers
@P	sudo -u josh gh issue edit 138 --add-label review
@P	env -S 'gh issue edit 138 --add-label review'
@P	printf '138\0' | xargs -0 -I{} gh issue edit {} --add-label review
@P	parallel gh issue edit {} --add-label review ::: 138
@P	watch gh issue edit 138 --add-label review
@P	nice -n 5 nohup timeout -s KILL 30 command gh issue edit 138 --add-label review
@P	exec gh issue edit 138 --add-label review
@P	time gh issue edit 138 --add-label review
## N9 other gh paths to the label
@P	gh api -X PATCH repos/joshgaskin/plus2/issues/138 -f 'labels[]=review'
@P	gh api repos/joshgaskin/plus2/issues/138/labels -f 'labels[]=review'
@P	gh issue edit 138 --add-label=review
@P	gh issue edit 138 --add-label Review
@P	gh pr edit 138 --add-label review
@P	gh issue edit 138 --add-label "bug,review"
@P	gh issue edit 138 --add-label bug --add-label review
## N10 -R value forms gh accepts
@P	gh issue edit 138 --add-label review -R git@github.com:joshgaskin/plus2.git
@P	gh issue edit 138 --add-label review -R https://github.com/joshgaskin/plus2.git
@P	gh issue edit 138 --add-label review -R github.com/joshgaskin/plus2
@P	gh issue edit 138 --add-label review -R=joshgaskin/hatchery
@P	gh issue edit 138 --add-label review -R joshgaskin/plus2 -R joshgaskin/hatchery
@P	GH_REPO=joshgaskin/hatchery gh issue edit 138 -R joshgaskin/plus2 --add-label review
@P	GH_REPO=joshgaskin/hatchery gh issue edit https://github.com/joshgaskin/plus2/issues/138 --add-label review
@P	export GH_REPO=joshgaskin/hatchery; unset GH_REPO; gh issue edit 138 --add-label review
@P	(export GH_REPO=joshgaskin/hatchery); gh issue edit 138 --add-label review
@P	env GH_REPO=joshgaskin/hatchery gh issue edit 138 --add-label review
## N11 bypass lookalikes
@P	f(){ export CATALINA_WITNESS_ALLOW=1; }; gh issue edit 138 --add-label review
@P	false && export CATALINA_WITNESS_ALLOW=1; gh issue edit 138 --add-label review
@P	cat <<'X'\nexport CATALINA_WITNESS_ALLOW=1\nX\ngh issue edit 138 --add-label review
@P	true # ; export CATALINA_WITNESS_ALLOW=1\ngh issue edit 138 --add-label review
@P	(export CATALINA_WITNESS_ALLOW=1); gh issue edit 138 --add-label review
@P	bash -c 'export CATALINA_WITNESS_ALLOW=1'; gh issue edit 138 --add-label review
@P	CATALINA_WITNESS_ALLOW=1 cd @H && gh issue edit 138 --add-label review
## N12 from a hatchery cwd
@H	cd ../plus2 && gh issue edit 138 --add-label review
@H	gh -R joshgaskin/plus2 issue edit 138 --add-label review
@H	(cd ../plus2 && git status) && gh issue edit 138 --add-label review
@H	cd @T | cat; gh issue edit 138 --add-label review
@H	false && cd @T; gh issue edit 138 --add-label review
@H	git -C ../plus2 log -1 && gh issue edit 138 --add-label review
@H	cd ../plus2 && git -C ../hatchery log -1 && gh issue edit 138 --add-label review
