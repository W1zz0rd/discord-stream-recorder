FROM node:16

RUN apt update && apt install -y xvfb chromium ffmpeg

RUN ln -s /usr/bin/chromium /usr/bin/google-chrome

RUN mkdir /temp \
    && version=$(curl "https://chromedriver.storage.googleapis.com/LATEST_RELEASE_90") \
    && wget -O "/temp/chromedriver_linux64.zip" "http://chromedriver.storage.googleapis.com/$version/chromedriver_linux64.zip" \
    && unzip "/temp/chromedriver_linux64.zip" chromedriver -d /usr/local/bin/ \
    && rm "/temp/chromedriver_linux64.zip"

RUN mkdir -p /home/app
COPY . /home/app
WORKDIR /home/app

RUN npm ci

CMD ["npm", "run", "entrypoint"]
