<?php

class GreetingService
{
    public function greeting(): string {
        return 'hello';
    }
}

class GreetingController
{
    public function show(GreetingService $service): string
    {
        return $service->greeting();
    }
}
