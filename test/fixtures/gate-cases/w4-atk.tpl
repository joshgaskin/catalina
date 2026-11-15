# From catalina (no #138 record, so the session check passes). Each flip, as real gh 2.78 reads it, edits hatchery#138
# or plus2#138, both of which fail their check. new=0 here means a flip lands on a failing record unchecked.
# --- issue-number and URL forms gh accepts (verified with real gh against fakegh.js)
@C	gh issue edit 5 +138 -R joshgaskin/hatchery --add-label @L
@C	gh issue edit 5 '#+0138' -R joshgaskin/hatchery --add-label @L
@C	gh issue edit +138 -R joshgaskin/hatchery --add-label @L
@C	gh issue edit https://github.com/joshgaskin/hatchery/pull/138 --add-label @L
@C	gh issue edit 5 https://github.com/joshgaskin/hatchery/pull/138 --add-label @L
@C	gh issue edit 5 https://github.com/joshgaskin/hatchery/pull/138 -R joshgaskin/catalina --add-label @L
@C	gh issue edit HTTPS://github.com/joshgaskin/hatchery/issues/138 --add-label @L
@C	gh issue edit 5 HTTPS://github.com/joshgaskin/hatchery/issues/138 --add-label @L
@C	gh issue edit https://github.com/joshgaskin/%68atchery/issues/138 --add-label @L
@C	gh issue edit 5 https://github.com/joshgaskin/hatchery/issues/%31%33%38 --add-label @L
@C	gh issue edit https://github.com/joshgaskin/hatchery/issues/%31%33%38 --add-label @L
@C	gh issue edit 138 -R joshgaskin/hatchery.git --add-label @L
# --- flags between issue and edit (cobra allows them)
@C	gh issue -R joshgaskin/hatchery edit 138 --add-label @L
@C	gh issue --repo=joshgaskin/hatchery edit 138 --add-label @L
@P	gh issue -R '' edit 138 --add-label @L
# --- label forms gh's StringSlice (CSV) reads as the label
@C	gh issue edit 138 -R joshgaskin/hatchery --add-label '"@L"'
@C	gh issue edit 138 -R joshgaskin/hatchery --add-label 'bug,"@L"'
# --- numbers the shell supplies
@C	N=138; gh issue edit 5 $N -R joshgaskin/hatchery --add-label @L
@C	echo 138 | xargs gh issue edit 5 -R joshgaskin/hatchery --add-label @L
@C	echo 138 | xargs -I{} gh issue edit {} -R joshgaskin/hatchery --add-label @L
@C	gh issue edit 13{8,9} -R joshgaskin/hatchery --add-label @L
@C	gh issue edit 5 13{8,9} -R joshgaskin/hatchery --add-label @L
# --- repo the cwd's git resolves to without a cd
@C	GIT_DIR=@H/.git gh issue edit 138 --add-label @L
@C	export GIT_DIR=@H/.git; gh issue edit 138 --add-label @L
@C	d=../hatchery; cd $d && gh issue edit 138 --add-label @L
@C	cd ../hatch*ry && gh issue edit 138 --add-label @L
@C	cd "$(echo ../hatchery)" && gh issue edit 138 --add-label @L
@C	cd ../hatchery\nexport GH_REPO\ngh issue edit 138 --add-label @L
# --- wrappers and quoting, explicit check
@C	command gh issue edit 138 -R joshgaskin/hatchery --add-label @L
@C	env gh issue edit 138 -R joshgaskin/hatchery --add-label @L
@C	"gh" issue edit 138 -R joshgaskin/hatchery --add-label @L
@C	g\h issue edit 138 -R joshgaskin/hatchery --add-label @L
@C	gh issue edit 138 \\n-R joshgaskin/hatchery --add-label @L
@C	gh issue edit 138 -R joshgaskin/hatchery --add-label @L\u000d
@C	gh issue edit 138 -R joshgaskin/hatchery --add-label rev""iew
@C	gh issue edit 138 -R joshgaskin/hatchery --add-label=rev{iew,iew}
@C	gh issue edit 138 -R joshgaskin/hatchery --add-label rev${x}iew
@C	(gh issue edit 138 -R joshgaskin/hatchery --add-label @L)
@C	true || gh issue edit 138 -R joshgaskin/hatchery --add-label @L
@C	false; gh issue edit 138 -R joshgaskin/hatchery --add-label @L
# --- explicit -R aimed at catalina while the argv also reaches hatchery
@C	gh issue edit 138 -R joshgaskin/catalina -R joshgaskin/hatchery --add-label @L
@C	gh -R joshgaskin/hatchery issue edit 138 -R joshgaskin/catalina --add-label @L
@C	gh issue edit https://github.com/joshgaskin/hatchery/issues/138 -R joshgaskin/catalina --add-label @L
@C	gh issue edit 138 -R joshgaskin/catalina --title x -R joshgaskin/hatchery --add-label @L
# --- GH_REPO
@C	GH_REPO=joshgaskin/hatchery gh issue edit 138 --add-label @L
@C	export GH_REPO=joshgaskin/hatchery; gh issue edit 138 --add-label @L
@C	gh issue edit 138 -R joshgaskin/catalina -R '' --add-label @L
