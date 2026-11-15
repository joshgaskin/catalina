# The third witness's set for #27 (w27c/new.tpl, 7292b85). @P plus2, @C catalina (a repo with no issue-138 dir), @S a scratch dir (repo/ with l -> plus2/src, clone/ of plus2, gone/, lock/, crash/, clink -> catalina), @F the plus2#138 flip.
@P	cd -Q @C; @F
@P	cd @C > /nonexistent/w27c/x; @F
@P	cd @C < /nonexistent/w27c/x; @F
@P	cd @C @H; @F
@P	cd @C \\nx; @F
@P	cd "~/Documents/dev/projects/catalina"; @F
@P	cd '$HOME/Documents/dev/projects/catalina'; @F
@P	cd "..\/catalina"; @F
@P	cd ../catalina\u000d; @F
@P	cd ../catalina x; @F
@P	cd ../catalina; @F
@P	cd\u000b../catalina; @F
@P	cd -P @S/repo/l/.. && @F
@P	set -P; cd @S/repo/l/.. && @F
@P	setopt chaselinks; cd @S/repo/l/.. && @F
@P	pushd -n @C && @F
@P	alias cd=:\ncd @C && @F
@P	disable cd; cd @C; @F
@P	enable -n cd; cd @C && @F
@P	GH_REPO=joshgaskin/plus2; export GH_REPO; cd @C && @F
@P	declare -x GH_REPO=joshgaskin/plus2; cd @C && @F
@P	set -a; GH_REPO=joshgaskin/plus2; cd @C && @F
@P	gh issue edit https://github.com/joshgaskin/plus2/issues/138 -R joshgaskin/catalina --add-label review
@P	gh issue edit https://github.com/joshgaskin/plus2/issues/138 --add-label review --repo=joshgaskin/catalina
@P	GH_REPO=joshgaskin/catalina gh issue edit https://github.com/joshgaskin/plus2/issues/138 --add-label review
@P	cd @S/clone && @F
@P	cd .claude/worktrees/issue-2228 && gh issue edit 19 --add-label review
@P	rm -rf @S/gone; cd @S/gone; @F
@P	chmod 000 @S/lock; cd @S/lock; @F
@P	cd -s @S/clink; @F
@P	builtin cd -Q @C; @F
@P	alias gh='gh -R joshgaskin/plus2'\ncd @C && @F
@P	true # cd @S/crash\n@F
@P	cd @S/crash && @F
@P	gh issue edit 0138 --add-label review
@P	cd @C && gh issue edit 0138 --add-label review
# controls (expected correct)
@P	cd @C; @F
@P	cd -- @C; @F
@P	cd @C 2>/dev/null; @F
@P	(cd @C); @F
@P	nice cd @C; @F
@P	gh -R joshgaskin/catalina issue edit https://github.com/joshgaskin/plus2/issues/138 --add-label review
@P	cd ~+/../catalina; @F
@P	env -C @C @F
@P	gh api graphql -f query='mutation{addLabelsToLabelable(input:{labelableId:"X",labelIds:["Y"]}){clientMutationId}}'
@P	GH_HOST=github.com @F
@P	cd @C && CATALINA_WITNESS_ALLOW=1 true; @F
