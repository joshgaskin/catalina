# decoy 99999 has no record in hatchery; gh also edits hatchery#138 (fails)
@C	gh issue edit 99999 +138 -R joshgaskin/hatchery --add-label @L
@C	gh issue edit 99999 '#+0138' -R joshgaskin/hatchery --add-label @L
@C	gh issue edit 99999 https://github.com/joshgaskin/hatchery/pull/138 -R joshgaskin/hatchery --add-label @L
@C	N=138; gh issue edit 99999 $N -R joshgaskin/hatchery --add-label @L
@C	echo 138 | xargs gh issue edit 99999 -R joshgaskin/hatchery --add-label @L
@C	gh issue edit 99999 13{8,9} -R joshgaskin/hatchery --add-label @L
@H	gh issue edit 99999 +138 --add-label @L
@H	gh issue edit 99999 HTTPS://github.com/joshgaskin/hatchery/issues/138 --add-label @L
@C	gh issue -R joshgaskin/hatchery edit 138 --add-label @L
@H	gh issue edit 138 --add-label '"@L"'
