#!/bin/bash

Xvfb :0 -screen 0 1920x1080x24 &
export DISPLAY=:0

npm run stream-recorder
